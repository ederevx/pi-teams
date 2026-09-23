"""Durable per-target inbox for messages the broker cannot hand off.

One owner for store-and-forward: when a target's connection is gone
(a hold restart, a client EOF) but it is still part of the team, the
broker parks the message here and delivers it when the target
registers again. Files live under the team root, so a broker restart
loses nothing; a message parked past ``ttl`` is dropped instead of
delivering stale traffic to a long-gone agent.
"""

import json
import os
import secrets
import time

from wire import dump_line

MAILBOX_DIR = "mailbox"


def _safe_name(agent_id):
    # An agent id carries a host label with ':'; flatten it so the
    # mailbox path stays portable across filesystems.
    return "".join(
        ch if ch.isalnum() or ch in "-._" else "_" for ch in str(agent_id)
    )


class Mailbox:
    """Owns the on-disk parked-message queue for one team root."""

    def __init__(self, root, ttl=120.0):
        self.root = root
        self.ttl = float(ttl)

    def _dir(self, agent_id):
        return self.root.base / MAILBOX_DIR / _safe_name(agent_id)

    def enqueue(self, agent_id, envelope):
        """Park one envelope and return its message id."""
        directory = self._dir(agent_id)
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError:
            return ""
        msg_id = secrets.token_hex(8)
        record = dict(envelope, id=msg_id, queued_ts=time.time())
        self.root.write_atomic(
            os.path.join(MAILBOX_DIR, _safe_name(agent_id),
                         "%s-%s.json" % (int(record["queued_ts"] * 1000),
                                         msg_id)),
            dump_line(record).decode("utf-8"))
        return msg_id

    def parked(self, agent_id):
        """Parked envelopes in order, kept on disk: the caller writes
        each to the target first and drops it after, so a crash in
        between costs a duplicate (absorbed by seen-id filtering),
        never a loss."""
        return self._load(agent_id)

    def drop(self, agent_id, msg_id):
        """Remove one delivered message from the parked queue."""
        directory = self._dir(agent_id)
        for path in self._json_files(directory):
            if str(path.name).endswith("-%s.json" % msg_id):
                self._unlink(path)
                return

    def _json_files(self, directory):
        try:
            return sorted(directory.glob("*.json"))
        except OSError:
            return []

    def _load(self, agent_id):
        # A malformed record is deleted, not kept: it can never be
        # delivered, and re-parsing it every poll wastes the sweep.
        return [
            record
            for record in map(self._read_record,
                              self._json_files(self._dir(agent_id)))
            if record is not None
        ]

    def _read_record(self, path):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return record if isinstance(record, dict) else None

    def _unlink(self, path):
        try:
            path.unlink()
        except OSError:
            pass

    def prune(self, now=None):
        """Delete expired parked messages and empty per-target dirs."""
        now = time.time() if now is None else now
        base = self.root.base / MAILBOX_DIR
        try:
            targets = list(base.iterdir())
        except OSError:
            return
        for directory in targets:
            if not directory.is_dir():
                continue
            for path in self._json_files(directory):
                record = self._read_record(path)
                queued = float((record or {}).get("queued_ts", 0))
                if now - queued > self.ttl:
                    self._unlink(path)
            try:
                if not any(directory.iterdir()):
                    directory.rmdir()
            except OSError:
                pass