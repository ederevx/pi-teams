"""Broker-side garbage collection of state files.

One owner for sweeping abandoned state around a team root: orphan
busy files, teammate transcripts with no live agent, aged write_atomic
scratch. Reads the registry (never mutates it); removes only files
whose owners are gone. The broker composes this from its sweep loop
and drop paths.
"""

import pathlib

from team_root import TEAMMATE_MARKER


class StateGc:
    """Owns the sweep of orphaned busy files, session files, and tmp
    scratch under a broker's root."""

    def __init__(self, root, registry, lock, sessions_root,
                 session_grace, busy_grace):
        self.root = root
        self.registry = registry
        self.lock = lock
        self.sessions_root = pathlib.Path(sessions_root)
        self.session_grace = session_grace
        self.busy_grace = busy_grace

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