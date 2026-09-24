"""The pi-teams client: one agent's persistent broker connection.

Speaks the broker protocol over its loopback TCP endpoint. Identity
comes from the environment (TEAM_ID, TEAM_NAME, ...) or is derived
from the process. One TeamClient holds one persistent connection:
while it stays open the agent is reachable and relays arrive on it.

Liveness is connection-based on every platform: hold() keeps the
endpoint open and exits on deregister, a terminate notice, or a
connection drop. Nothing here kills processes or names pids, so the
client stays portable across POSIX and Windows.
"""

import json
import os
import random
import socket
import sys
import threading
import time

from team_root import DEFAULT_ROOT, TeamRoot
from wire import LineStream, dump_line

HEARTBEAT_DEFAULT = 6.0


class TeamClient:
    """One agent's persistent connection to the team endpoint."""

    def __init__(self, root=None, timeout=2.0, heartbeat=HEARTBEAT_DEFAULT):
        self.root = TeamRoot(root or DEFAULT_ROOT)
        self.timeout = timeout
        self.heartbeat = heartbeat
        self.id = os.environ.get("TEAM_ID")
        self.name = os.environ.get("TEAM_NAME")
        self.role = os.environ.get("TEAM_ROLE")
        self.parent = os.environ.get("TEAM_PARENT_ID")
        self.session = os.environ.get("TEAM_SESSION")
        self.owner_pid = os.environ.get("TEAM_OWNER_PID")
        self.busy_file = os.environ.get("TEAM_BUSY_FILE")
        self.attached = os.environ.get("TEAM_ATTACHED") == "1"
        # The send token the hold was launched with, so gated ops stay
        # pre-authorized (an old gate-less broker ignores the field).
        self.send_token = os.environ.get("TEAM_SEND_TOKEN")
        self._conn = None
        self._stream = LineStream()
        # Guards _conn and watcher handles against two-owner mutation.
        self._lock = threading.RLock()
        self._generation = 0
        self._heartbeat_thread = None
        self._stdin_event = None

    # -- identity ----------------------------------------------------

    def ensure_id(self):
        if not self.id:
            self.id = "cli-%d-%s" % (
                os.getpid(),
                "%08x" % random.getrandbits(32),
            )
        if not self.name:
            self.name = self.id
        return self.id

    def meta(self):
        return {
            "id": self.ensure_id(),
            "name": self.name,
            "role": self.role or "cli",
            "parent": self.parent,
            "cwd": os.getcwd(),
            "session": self.session,
            "owner_pid": self.owner_pid,
            "busy_file": self.busy_file,
            "attached": bool(self.attached),
            "send_token": self.send_token or "",
        }

    def set_identity(self, agent_id=None, name=None, role=None, parent=None,
                     session=None, owner_pid=None, busy_file=None,
                     attached=None, send_token=None):
        # Explicit identity from CLI args (pi.exec cannot pass env on
        # Windows, so identity travels as args).
        if agent_id:
            self.id = agent_id
        if name:
            self.name = name
        if role:
            self.role = role
        if parent:
            self.parent = parent
        if session:
            self.session = session
        if owner_pid:
            self.owner_pid = owner_pid
        if busy_file:
            self.busy_file = busy_file
        if send_token:
            self.send_token = send_token
        if attached is not None:
            self.attached = bool(attached)

    # -- transport ---------------------------------------------------

    def connect(self):
        if self._conn is not None:
            return self._conn
        endpoint = self.root.read_endpoint()
        if not endpoint:
            raise OSError("no teamd endpoint under %s" % self.root.base)
        conn = self._open(endpoint)
        with self._lock:
            if self._conn is not None:
                # Another thread won the race; drop the extra socket.
                try:
                    conn.close()
                except OSError:
                    pass
                return self._conn
            self._conn = conn
            self._generation += 1
        self._handshake(endpoint)
        return conn

    def _open(self, endpoint):
        conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        conn.settimeout(self.timeout)
        try:
            conn.connect((endpoint["host"], endpoint["port"]))
        except OSError:
            # A failed connect leaves no fd behind.
            try:
                conn.close()
            except OSError:
                pass
            raise
        return conn

    def _handshake(self, endpoint):
        self._send_line({"op": "hello", "token": endpoint.get("token") or ""})
        reply = self._read_line()
        if not reply or reply.get("op") != "ack":
            self.close()
            raise OSError("teamd handshake failed: %r" % (reply,))

    def close(self):
        with self._lock:
            conn, self._conn = self._conn, None
            self._stream = LineStream()
            # A generation bump retires every heartbeat and read loop that
            # captured the old connection.
            self._generation += 1
            event = self._stdin_event
            self._stdin_event = None
        if event is not None:
            event.set()
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass

    def _send_line(self, obj):
        self.connect().sendall(dump_line(obj))

    def _read_line(self):
        while True:
            line = self._stream.next_line()
            if line is not None:
                return json.loads(line.decode("utf-8"))
            chunk = self.connect().recv(65536)
            if not chunk:
                return None
            self._stream.push(chunk)

    def send(self, obj):
        self._send_line(obj)

    def request(self, op, expected=("ack", "error", "registry"),
                timeout=None, **fields):
        # `timeout` extends the socket wait for ops where the broker
        # blocks (peer-add reads the peer endpoint over ssh).
        conn = self.connect()
        if timeout is not None:
            conn.settimeout(timeout)
        try:
            self._send_line(dict(fields, op=op))
            while True:
                reply = self._read_line()
                if reply is None:
                    return {"op": "error", "error": "closed"}
                if reply.get("op") in expected:
                    return reply
        finally:
            if timeout is not None:
                conn.settimeout(self.timeout)

    # -- operations --------------------------------------------------

    def register(self):
        reply = self.request("register", expected=("ack", "error"),
                             **self.meta())
        if self._conn is not None:
            self._start_heartbeat()
        return reply

    def send_msg(self, to, kind, payload):
        return self.request(
            "send", expected=("ack", "error"), to=to,
            **{"from": self.ensure_id()}, kind=kind, payload=payload,
            send_token=self.send_token or "", ts=time.time(),
        )

    def ls(self):
        return self.request("ls", expected=("registry", "error"))

    def _peer_op(self, op, timeout, **params):
        return self.request(op, expected=("ack", "error"),
                            timeout=timeout, **params)

    def terminate(self, agent_id, why="requested"):
        # A peer-terminate waits for the target host's broker to ack or
        # for the pending-relay window, so allow more than a round trip.
        return self._peer_op("terminate", 20, to=agent_id, why=why)

    def peer_add(self, label, ssh):
        return self._peer_op("peer-add", 35, label=label, ssh=ssh)

    def peer_remove(self, label):
        return self._peer_op("peer-remove", 15, label=label)

    def peer_list(self):
        return self.request("peer-list", expected=("peers", "error"))

    def deregister(self):
        reply = self.request("deregister", expected=("ack", "error"))
        self.close()
        return reply

    # -- streaming ----------------------------------------------------

    def _start_heartbeat(self):
        # A repeated register() must not leak a second heartbeat thread.
        if not self.heartbeat:
            return
        with self._lock:
            if (self._heartbeat_thread is not None
                    and self._heartbeat_thread.is_alive()):
                return
            generation = self._generation
            thread = threading.Thread(
                target=self._heartbeat, args=(generation,), daemon=True
            )
            self._heartbeat_thread = thread
        thread.start()

    def _heartbeat(self, generation):
        # The captured generation pins this loop to its connection:
        # close() bumps it, so a late wake cannot send on a dead or
        # replaced socket.
        while True:
            time.sleep(self.heartbeat)
            with self._lock:
                if self._generation != generation or self._conn is None:
                    return
                conn = self._conn
            state = self._state()
            data = dump_line({
                "op": "ping",
                "busy": state == "busy",
                "waiting": state == "waiting",
            })
            with self._lock:
                if self._generation != generation or self._conn is not conn:
                    return
                try:
                    conn.sendall(data)
                except OSError:
                    return

    def _state(self):
        # The spawner publishes 1=busy, 2=waiting, 0/absent=idle. A
        # waiting agent is not working, but the broker keeps it exempt
        # from idle GC, so it is reported separately from busy.
        if not self.busy_file:
            return "idle"
        try:
            with open(self.busy_file) as fh:
                value = fh.read().strip()
        except (OSError, IOError):
            return "idle"
        return {"1": "busy", "2": "waiting"}.get(value, "idle")

    def follow(self, on_message=None, ready=None):
        self.register()
        if ready is not None:
            ready()
        try:
            while True:
                try:
                    msg = self._read_line()
                except socket.timeout:
                    continue
                except OSError:
                    break
                if msg is None:
                    break
                if on_message is not None:
                    on_message(msg)
                else:
                    print(dump_line(msg).decode("utf-8"), flush=True)
        finally:
            self.close()

    def _watch_stdin(self):
        # EOF on stdin means the hosting process is gone: exit so the
        # endpoint dies with its pi instead of pinging as an orphan.
        # Every stdin is watched except a real interactive console,
        # whose input must never be consumed; a console is recognized
        # with os.get_terminal_size, not isatty (Windows reports isatty
        # true for the NUL device, so a detached-stdin hold would never
        # see its EOF and would outlive its host).
        dead = threading.Event()
        try:
            os.get_terminal_size(sys.stdin.fileno())
            return dead
        except (OSError, ValueError):
            pass

        # close() sets the event so the watcher stops at the next read
        # boundary instead of outliving the connection.
        self._stdin_event = dead

        def watch():
            try:
                while not dead.is_set():
                    if not sys.stdin.read(4096):
                        dead.set()
                        return
            except (OSError, ValueError):
                dead.set()

        threading.Thread(target=watch, daemon=True).start()
        return dead

    def _emit(self, msg):
        # Inbound relayed traffic on stdout for the hosting extension;
        # registry churn is internal bookkeeping, never agent-facing.
        if msg.get("op") != "message" or msg.get("kind") == "registry-change":
            return
        print(json.dumps(msg, separators=(",", ":")), flush=True)

    def _remove_warning(self, msg):
        # A busy or waiting agent deletes the broker's idle warning file
        # at once; the broker sees the deletion as a working answer.
        payload = msg.get("payload")
        path = payload.get("file") if isinstance(payload, dict) else None
        if not path:
            return
        try:
            os.unlink(path)
        except OSError:
            pass

    def hold(self):
        self.register()
        stdin_dead = self._watch_stdin()
        try:
            while True:
                try:
                    msg = self._read_line()
                except socket.timeout:
                    if stdin_dead.is_set():
                        return
                    continue
                except OSError:
                    break
                if msg is None or msg.get("kind") == "terminate":
                    return
                if msg.get("kind") == "idle-warning":
                    # A busy or waiting agent is still working: delete
                    # the warning file at once. An idle one is blocked
                    # in pi, so the warning is surfaced for its turn.
                    if self._state() in ("busy", "waiting"):
                        self._remove_warning(msg)
                    else:
                        self._emit(msg)
                    continue
                self._emit(msg)
                if stdin_dead.is_set():
                    return
        finally:
            self.close()