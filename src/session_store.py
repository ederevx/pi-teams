"""Conversation-file lifetime under pi's session store.

One owner for what happens on disk to a teammate's transcript. A
transcript is a pi conversation that `/resume` reads, so its lifetime
is the conversation's, not the teammate process's: ending a teammate
must never erase the conversation a user may resume. This class holds
the teammate marker, the sessions root, and the single retention rule -
a teammate-marked transcript no live process backs and no recent work
touched is reclaimed - and nothing else deletes a transcript.
"""

import pathlib

from team_root import TEAMMATE_MARKER

# The marker sits in the first user turn, so a sweep scans only the head
# rather than reading a large transcript whole.
MARKER_SCAN_LINES = 50


class SessionStore:
    """Owns teammate-transcript identity and retention."""

    def __init__(self, root, sessions_root, grace):
        self.root = root
        self.base = pathlib.Path(sessions_root)
        self.grace = float(grace)

    def files(self):
        """Every transcript candidate under the sessions root."""
        try:
            return list(self.base.glob("**/*.jsonl"))
        except OSError:
            return []

    def is_teammate(self, path):
        # The marker scan is byte-based on purpose: the locale text
        # codec differs per platform (cp1252 on Windows), and decoding
        # through the wrong codec would raise and kill the sweep.
        marker = TEAMMATE_MARKER.encode("utf-8")
        try:
            with open(path, "rb") as handle:
                for index, line in enumerate(handle):
                    if marker in line:
                        return True
                    if index >= MARKER_SCAN_LINES:
                        break
        except OSError:
            return False
        return False

    def reclaim(self, live, now):
        """Reclaim teammate transcripts no live process backs and no
        recent work touched; return the removed paths. A transcript is
        never reclaimed because a registration dropped, only because it
        is abandoned and aged."""
        removed = []
        for path in self.files():
            if not self._abandoned(path, live, now):
                continue
            self.root.unlink_under(str(path), self.base)
            removed.append(str(path))
        return removed

    def _abandoned(self, path, live, now):
        try:
            if str(path.resolve()) in live:
                return False
            if path.stat().st_mtime > now - self.grace:
                return False
        except OSError:
            return False
        return self.is_teammate(path)
