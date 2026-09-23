"""Broker-side garbage collection of state files.

One owner for sweeping abandoned state around a team root: orphan busy
files, teammate session transcripts with no live agent, and aged
write_atomic scratch. It reads the registry (never mutates it) and
removes only files whose owners are gone; the broker composes this
owner from its sweep loop and its drop paths.
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
        # A busy file is published by the extension, not the broker. One
        # whose agent is no longer registered and has not been touched for
        # the grace window belongs to an old session; remove it. A
        # registered agent (even a busy fork with an old mtime) keeps its
        # file.
        files = self.root.busy_files()
        with self.lock:
            live = {
                str(pathlib.Path(entry["busy_file"]).resolve())
                for entry in self.registry.values()
                if entry.get("busy_file")
            }
        for path in files:
            try:
                if str(path.resolve()) in live:
                    continue
                if path.stat().st_mtime > now - self.busy_grace:
                    continue
            except OSError:
                continue
            self.root.unlink_under(str(path), self.root.base)

    def gc_orphan_session_files(self, now):
        # Every teammate is a pi session that shows up in /resume. Remove
        # teammate-marked session files whose agent is not live and whose
        # mtime is older than the grace. A user's own session is never
        # marked, and a live fork's file is skipped regardless of mtime.
        # NOTE: this globs the whole sessions tree every interval; if that
        # tree ever grows past a bounded size the glob itself should become
        # incremental, but changing it risks the mtime-grace semantics.
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
        for path in files:
            try:
                if str(path.resolve()) in live:
                    continue
                if path.stat().st_mtime > now - self.session_grace:
                    continue
            except OSError:
                continue
            if self.is_teammate_session(path):
                self.root.unlink_under(str(path), self.sessions_root)

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