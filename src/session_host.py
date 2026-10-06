"""Client for a pi-pty-host/1 provider's control endpoint.

The daemon handshake and the one-request JSON-line framing mirror the
pi-rc control client: connect over loopback TCP, send the mandatory
`{"cmd": "hello", "token": ...}` line, read the ack, then send one
request line and read one response line on the same short-lived
connection. This module owns the transport only; provider selection and
fallback live in session_provider.
"""

import json
import pathlib
import socket

PROTOCOL = "pi-pty-host/1"
CONTROL_TIMEOUT = 5.0


def _send_json(sock, obj):
    sock.sendall(json.dumps(obj).encode() + b"\n")


def _read_json_line(sock):
    # One response line; None when the peer closes or sends non-JSON.
    buf = b""
    while b"\n" not in buf:
        try:
            data = sock.recv(65536)
        except OSError:
            return None
        if not data:
            return None
        buf += data
    line = buf.split(b"\n", 1)[0]
    try:
        return json.loads(line.decode())
    except (ValueError, UnicodeDecodeError):
        return None


class SessionHostClient:
    """Speaks the session-host control protocol for one provider."""

    def __init__(self, descriptor, timeout=CONTROL_TIMEOUT):
        self.descriptor = dict(descriptor)
        self.timeout = timeout

    def endpoint(self):
        """The provider's published {host, port, token}; a missing or
        malformed endpoint file reads as an OSError."""
        path = self.descriptor.get("endpoint_file")
        try:
            data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError):
            raise OSError("session-host endpoint unavailable")
        if not isinstance(data, dict) or not data.get("host") \
                or not data.get("port"):
            raise OSError("session-host endpoint unavailable")
        return data

    def connect(self, timeout=None):
        """A handshaken control socket; the caller closes it."""
        data = self.endpoint()
        sock = socket.create_connection(
            (data["host"], data["port"]),
            self.timeout if timeout is None else timeout)
        try:
            _send_json(sock, {"cmd": "hello",
                              "token": data.get("token") or ""})
            reply = _read_json_line(sock)
            if not isinstance(reply, dict) or not reply.get("ok"):
                raise OSError("session-host handshake rejected")
        except OSError:
            sock.close()
            raise
        return sock

    def request(self, payload, timeout=None):
        """One JSON-line round-trip; returns the response dict."""
        sock = self.connect(timeout)
        try:
            _send_json(sock, payload)
            reply = _read_json_line(sock)
        finally:
            sock.close()
        if not isinstance(reply, dict):
            raise OSError("session-host closed without a response")
        return reply

    def start(self, session, cwd, argv, env=None):
        """Start a session; maps to the daemon's `start` command and
        returns its {"ok": ..., "error"?} response. `env` is optional."""
        req = {"cmd": "start", "name": session, "dir": cwd,
               "argv": list(argv)}
        if env is not None:
            req["env"] = dict(env)
        return self.request(req)

    def stop(self, session):
        """Stop one session; returns the daemon's response."""
        return self.request({"cmd": "stop", "name": session})

    def list(self):
        """List sessions; returns the daemon's response."""
        return self.request({"cmd": "list"})
