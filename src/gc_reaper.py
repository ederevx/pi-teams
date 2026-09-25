"""Broker-side garbage collection: one idle self-reap policy plus the
orphan-file sweeps.

One owner for every GC decision the broker makes: the single idle
window that asks a reachable session to reap itself, and the retention
sweeps of orphan busy files, teammate transcripts, and aged write
scratch. Reads the registry (never mutates it); removes only files
whose owners are gone. The broker composes this from its sweep loop and
drop paths.
"""

import pathlib
import time

from team_root import TEAMMATE_MARKER


class GcReaper:
    """Owns the idle self-reap request and the orphan-file sweeps under
    a broker's root."""

    def __init__(self, root, registry, lock, sessions_root, session_grace,
                 busy_grace, gc_idle, session_sweep_interval,
                 request_reap):
        self.root = root
        self.registry = registry
        self.lock = lock
        self.sessions_root = pathlib.Path(sessions_root)
        self.session_grace = session_grace
        self.busy_grace = busy_grace
        # The one idle window, in seconds; zero disables the policy.
        self.gc_idle = float(gc_idle)
        self.session_sweep_interval = float(session_sweep_interval)
        # write_atomic leaves a .tmp.<pid> scratch only when every
        # rename retry failed; sweep those aged leftovers on this
        # cadence so one crashed write cannot litter the root.
        self.tmp_sweep_interval = 3600.0
        # The callback builds and sends the wire request; the policy
        # here only decides when, and treats a False answer (a dropped
        # connection) as retryable on the next sweep.
        self.request_reap = request_reap
        self._last_session_sweep = 0.0
        self._last_tmp_sweep = 0.0
        # Ids already asked to reap; kept until the session shows work
        # or leaves, so one idle episode earns exactly one request.
        self._requested = set()

    def request_idle_reaps(self, now):
        # The single idle policy: a reachable session with no work
        # contact past gc_idle is asked to call its own reap tool. A
        # session asked once is not asked again until it works again or
        # leaves, and a session that never answers is left alone (its
        # connection liveness still owns the eventual cleanup).
        if self.gc_idle <= 0:
            return
        with self.lock:
            due = [
                agent_id for agent_id, entry in self.registry.items()
                if not entry.get("waiting")
                and entry.get("last_work", 0) < now - self.gc_idle
            ]
        self._requested &= set(due)
        for agent_id in due:
            if agent_id in self._requested:
                continue
            if self.request_reap(agent_id, "idle"):
                self._requested.add(agent_id)

    def forget_request(self, agent_id):
        # Work contact or a release ends the idle episode, so the next
        # idle window earns a fresh request.
        self._requested.discard(agent_id)

    def gc_orphan_busy_files(self, now):
        # A busy file is published by the extension, not the broker;
        # one neither registered nor touched within the grace belongs
        # to an old session. A registered agent keeps its file.
        files = self.root.busy_files()
        with self.lock:
            live = {
                str(pathlib.Path(entry["busy_file"]).resolve())
                for entry in self.registry.values()
                if entry.get("busy_file")
            }
        self._sweep(files, live, now, self.busy_grace, self.root.base)

    def gc_orphan_session_files(self, now):
        # Every teammate is a pi session in /resume; remove
        # teammate-marked files neither live nor touched within the
        # grace (a user's own session is never marked, a live fork's
        # file is skipped regardless of mtime). NOTE: globs the whole
        # sessions tree each interval by design.
        if now - self._last_session_sweep < self.session_sweep_interval:
            return
        self._last_session_sweep = now
        try:
            files = list(self.sessions_root.glob("**/*.jsonl"))
        except OSError:
            return
        with self.lock:
            live = {
                str(pathlib.Path(entry["session"]).resolve())
                for entry in self.registry.values()
                if entry.get("session")
            }
        self._sweep(files, live, now, self.session_grace,
                    self.sessions_root, teammate_marked=True)

    def gc_tmp_files(self, now):
        # The root owns the scratch paths; the reaper owns the cadence
        # so a crashed write cannot litter the root (any depth) forever.
        if now - self._last_tmp_sweep < self.tmp_sweep_interval:
            return
        self._last_tmp_sweep = now
        self.root.gc_tmp_files(now, self.busy_grace)

    def _sweep(self, files, live, now, grace, base, teammate_marked=False):
        # One orphan sweep for every file kind: remove files neither
        # live-owned nor touched within the grace.
        for path in files:
            try:
                if str(path.resolve()) in live:
                    continue
                if path.stat().st_mtime > now - grace:
                    continue
            except OSError:
                continue
            if not teammate_marked or self.is_teammate_session(path):
                self.root.unlink_under(str(path), base)

    def remove_session_file(self, entry):
        if (entry or {}).get("role") != "fork":
            return
        path = (entry or {}).get("session")
        # Only a spawned teammate's transcript is broker-owned and safe to
        # remove. An attached session carries no spawn marker and must
        # stay in /resume after the fork is reaped.
        if path and self.is_teammate_session(path):
            self.root.unlink_under(path, self.sessions_root)

    def is_teammate_session(self, path):
        # The marker sits in the first user turn; scan only the head so a
        # large transcript is never fully read during a sweep. The scan
        # is byte-based on purpose: the locale text codec differs per
        # platform (cp1252 on Windows), and a non-ASCII session file
        # decoded through the wrong codec would raise and kill the whole
        # sweep thread.
        marker = TEAMMATE_MARKER.encode("utf-8")
        try:
            with open(path, "rb") as fh:
                for index, line in enumerate(fh):
                    if marker in line:
                        return True
                    if index >= 50:
                        break
        except OSError:
            return False
        return False
