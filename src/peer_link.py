"""One broker's authenticated link to a peer broker.

Either side may open it: the initiator connects and starts a read
loop; the acceptor wraps the accepted socket for the caller's loop to
feed. Both directions carry relay traffic and registry snapshots over
one stream.
"""

import json
import socket
import threading

from wire import LineStream, dump_line


class PeerLink:
    """One broker's authenticated, bidirectional link to a peer broker."""

    def __init__(self, owner, host, endpoint=None, conn=None):
        self.owner = owner
        self.host = host
        self.endpoint = endpoint or {}
        self.conn = conn
        self.connected = conn is not None
        self._stream = LineStream()
        self._send_lock = threading.Lock()
        self._drop_lock = threading.Lock()

    def drop_in_place(self):
        # Link drop + endpoint clear in one step: an explicit removal
        # cannot leave a reconnectable endpoint on a dead link.
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
                self.conn.sendall(dump_line(obj))
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
                self._stream.push(chunk)
                while True:
                    line = self._stream.next_line()
                    if line is None:
                        break
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