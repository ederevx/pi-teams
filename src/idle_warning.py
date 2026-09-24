"""File-based idle warnings for the broker's courtesy GC.

Before the broker reaps a work-idle (or parent-gone) fork it leaves a
timestamped warning file for the teammate and spares the fork while the
file is young. Deleting the file is the teammate's working answer; a
file left in place past the grace is consent to the reap. This module
owns that file's contents and the in-memory record of outstanding
warnings; the broker only warns, checks, or clears. The file is the
source of truth for the timestamp, so a broker restart still reaps a
warning that has aged out.
"""

import time


class IdleWarnings:
    """Timestamped warning files, one per doomed fork."""

    def __init__(self, root, grace):
        self.root = root
        self.grace = float(grace)
        # Ids the broker has warned; the file's removal is only an
        # answer for an id already in this set.
        self._known = set()

    @property
    def enabled(self):
        # Zero disables the warning and reaps immediately.
        return self.grace > 0

    def path(self, agent_id):
        return self.root.warning_path(agent_id)

    def exists(self, agent_id):
        # Whether the warning file is present at all: a known id whose
        # file is gone was answered, a corrupt file is present and gets
        # replaced by the next warn.
        try:
            return self.path(agent_id).exists()
        except OSError:
            return False

    def record(self, agent_id):
        # The on-disk warning, or None once the teammate deleted it (or
        # the file is unreadable).
        return self.root.read_warning(agent_id)

    @property
    def known_ids(self):
        return set(self._known)

    def warn(self, agent_id, why, now=None):
        # Writes the timestamped warning file and remembers the id only
        # when the write actually landed: a failed write must not look
        # like an answered warning on the next sweep. Returns whether
        # the file is in place.
        ts = self._now(now)
        try:
            written = bool(
                self.root.write_warning(
                    agent_id, {"id": agent_id, "why": why, "ts": ts}))
        except OSError:
            written = False
        if written:
            self._known.add(agent_id)
        return written

    def is_open(self, agent_id, now=None):
        # A present, young warning spares the agent from this sweep.
        record = self.record(agent_id)
        if record is None:
            return False
        ts = record.get("ts")
        if not isinstance(ts, (int, float)):
            ts = self._mtime(agent_id)
        if ts is None:
            return False
        return self._now(now) - ts < self.grace

    def clear(self, agent_id):
        # Drops the warning once it was answered or its agent left.
        self._known.discard(agent_id)
        self.root.remove_warning(agent_id)

    def clear_all(self):
        # Shutdown leaves no warning state behind.
        for agent_id in list(self._known):
            self.clear(agent_id)

    def _mtime(self, agent_id):
        # A warning written by an older broker carries no ts: its mtime
        # still ages it out instead of sparing it forever.
        try:
            return self.path(agent_id).stat().st_mtime
        except OSError:
            return None

    @staticmethod
    def _now(now):
        return time.time() if now is None else now