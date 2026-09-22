"""One broker's authenticated link to a peer broker.

Either side may open it: the initiator connects and starts a read
loop; the acceptor wraps the accepted socket and lets the caller's
connection loop feed it. Both directions carry peer-relay traffic and
peer-registry snapshots over a single stream.
"""

import json
import socket
import threading


class PeerLink:
    """One broker's authenticated, bidirectional link to a peer broker."""

    def __init__(self, owner, host, endpoint=None, conn=None):
        self.owner = owner
        self.host = host
        self.endpoint = endpoint or {}
        self.conn = conn
        self.connected = conn is not None
        self._buf = b""
        self._send_lock = threading.Lock()
        self._drop_lock = threading.Lock()

    def drop_in_place(self):
        # Drops the link and clears the endpoint in one owned step, so a
        # drop-in-place (an explicit removal or shutdown) cannot leave a
        # reconnectable endpoint behind on a dead link.
        self.endpoint = {}
        self.drop()

    def open(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.settimeout(2.0)
            sock.connect((self.endpoint["host"], self.endpoint["port"]))
            sock.settimeout(0.5)
        except OSError:
            # A connect that never established leaves no fd behind.
            try:
                sock.close()
            except OSError:
                pass
            raise
        self.conn = sock
        self.connected = True
        self.send({"op": "hello", "token": self.endpoint.get("token") or ""})
        self.send({"op": "peer", "host": self.owner.host})
        threading.Thread(target=self._read_loop, daemon=True).start()
        return True

    def send(self, obj):
        if not self.connected or self.conn is None:
            return False
        try:
            with self._send_lock:
                self.conn.sendall(
                    (json.dumps(obj, separators=(",", ":")) + "\n").encode()
                )
            return True
        except OSError:
            self.drop()
            return False

    def _read_loop(self):
        try:
            while self.connected and self.conn is not None:
                try:
                    chunk = self.conn.recv(65536)
                except socket.timeout:
                    continue
                except OSError:
                    break
                if not chunk:
                    break
                self._buf += chunk
                while b"\n" in self._buf:
                    line, self._buf = self._buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        msg = json.loads(line.decode("utf-8"))
                    except ValueError:
                        continue
                    self.owner._peer_message(self, msg)
        finally:
            self.drop()

    def feed(self, msg):
        # Acceptor path: the broker's own loop already framed the message.
        self.owner._peer_message(self, msg)

    def drop(self):
        with self._drop_lock:
            if not self.connected and self.conn is None:
                return
            self.connected = False
            conn, self.conn = self.conn, None
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass
        self.owner._peer_down(self)