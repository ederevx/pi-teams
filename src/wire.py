"""JSON-lines wire framing for the broker protocol.

One owner for newline-terminated JSON bytes: every socket (client,
broker connections, peer links) frames messages the same way, so the
accumulate-and-split lives here once.
"""

import json


def dump_line(obj):
    """One wire line: compact JSON plus the newline terminator."""
    return (json.dumps(obj, separators=(",", ":")) + "\n").encode()


class LineStream:
    """Accumulates socket chunks and yields complete lines."""

    def __init__(self):
        self._buf = b""

    def push(self, chunk):
        self._buf += chunk

    def next_line(self):
        """The next complete line, or None when none is buffered."""
        if b"\n" not in self._buf:
            return None
        line, self._buf = self._buf.split(b"\n", 1)
        return line
