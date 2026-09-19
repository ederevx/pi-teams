#!/usr/bin/env python3
"""teamd - the pi-teams broker.

Serves one OS-agnostic endpoint: a loopback TCP listener on 127.0.0.1
with an ephemeral port and a random token. The address and token are
published atomically in the team root (endpoint), and every connection
must present the token in a hello handshake before any other op. Agents
register once, then exchange JSON-lines messages; the broker relays to
online recipients, mirrors the registry, and enforces fork lifetime
through connections only.

There is no pid probing anywhere: liveness is connection liveness. A
connection that closes (EOF) ends its agent; entries idle past the
heartbeat timeout are swept. When a fork's parent entry disappears, the
broker sends that fork a terminate notice on its connection and closes
it, so a team cannot outlive the process that spawned it. Nothing here
kills processes or names pids, which keeps the broker portable.

Protocol (one JSON object per line, both directions):
  hello/{op, token}            mandatory first message; ack on success
  register/{op,id,name,role,parent,cwd,session}
  send/{op,to,from,kind,payload,ts}  ping/{op}  ls/{op}
  terminate/{op,to,why}        deregister/{op}  shutdown/{op}
Reply objects use op "ack", "error", "registry", "message",
"registry-change", or "terminated". Notices use kind "terminate".
"""

import argparse
import json
import os
import pathlib
import secrets
import socket
import sys
import threading
import time

DEFAULT_ROOT = os.path.join(os.path.expanduser("~"), ".local", "state", "pi-teams")
ENDPOINT_NAME = "endpoint"
REGISTRY_NAME = "registry.json"
PID_NAME = "teamd.pid"


class TeamRoot:
    """Owns the paths and atomic writes for one team root."""

    def __init__(self, root):
        self.base = pathlib.Path(root)
        self.endpoint = self.base / ENDPOINT_NAME
        self.registry = self.base / REGISTRY_NAME
        self.pidfile = self.base / PID_NAME

    def ensure(self):
        self.base.mkdir(parents=True, exist_ok=True)

    def write_atomic(self, relative, data, mode=0o644):
        self.ensure()
        target = self.base / relative
        tmp = self.base / ("%s.tmp.%d" % (relative, os.getpid()))
        tmp.write_text(data)
        try:
            os.chmod(str(tmp), mode)
            os.replace(str(tmp), str(target))
        except FileNotFoundError:
            # Mirror-only write: the owning root was removed (e.g. test
            # teardown raced a lingering connection thread). The
            # in-memory registry remains authoritative.
            pass

    def read_endpoint(self):
        try:
            return json.loads(self.endpoint.read_text())
        except (OSError, ValueError):
            return {}


class TeamBroker:
    """Registry + relay for connected agents on one loopback endpoint."""

    def __init__(self, root=None, idle_timeout=15.0, sweep_interval=1.0):
        self.root = TeamRoot(root or DEFAULT_ROOT)
        self.idle_timeout = idle_timeout
        self.sweep_interval = sweep_interval
        self.token = secrets.token_hex(16)
        self._registry = {}
        self._clients = {}
        self._lock = threading.RLock()
        self._running = False
        self._server = None

    # -- lifecycle ---------------------------------------------------

    def run(self):
        self.root.ensure()
        self._running = True
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(16)
        port = self._server.getsockname()[1]
        self.root.write_atomic(
            ENDPOINT_NAME,
            json.dumps(
                {"host": "127.0.0.1", "port": port, "token": self.token},
                indent=2,
            )
            + "\n",
            mode=0o600,
        )
        self.root.write_atomic(PID_NAME, "%d\n" % os.getpid())
        threading.Thread(target=self._sweep_loop, daemon=True).start()
        try:
            while self._running:
                try:
                    conn, _ = self._server.accept()
                except OSError:
                    break
                threading.Thread(
                    target=self._serve, args=(conn,), daemon=True
                ).start()
        finally:
            self._close_all()
            try:
                self._server.close()
            except OSError:
                pass

    def stop(self):
        self._running = False
        try:
            self._server.close()
        except OSError:
            pass

    # -- connection handling ----------------------------------------

    def _serve(self, conn):
        agent_id = None
        try:
            with conn:
                conn.settimeout(0.5)
                buf = b""
                first = True
                while self._running:
                    try:
                        chunk = conn.recv(65536)
                    except socket.timeout:
                        continue
                    except OSError:
                        break
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        if not line.strip():
                            continue
                        try:
                            msg = json.loads(line.decode("utf-8"))
                        except ValueError:
                            self._reply(conn, op="error", error="bad-json")
                            break
                        if first:
                            if not self._handshake(conn, msg):
                                return
                            first = False
                            continue
                        agent_id = self._handle(conn, msg, agent_id)
                        if agent_id is None and not self._running:
                            return
        finally:
            self._drop_conn(agent_id)

    def _handshake(self, conn, msg):
        if msg.get("op") != "hello" or msg.get("token") != self.token:
            self._reply(conn, op="error", error="bad-handshake")
            return False
        self._reply(conn, op="ack", srv="teamd")
        return True

    def _handle(self, conn, msg, agent_id):
        op = msg.get("op")
        if op == "register":
            agent_id = self._register(conn, msg)
        elif op == "send":
            self._relay(msg, agent_id, conn)
        elif op == "broadcast":
            self._broadcast(msg.get("kind"), msg.get("payload"),
                            exclude=agent_id)
        elif op == "ls":
            self._reply(conn, op="registry", agents=self._snapshot())
        elif op == "ping":
            self._touch(agent_id)
            self._reply(conn, op="ack")
        elif op == "terminate":
            self._terminate(msg.get("to"), msg.get("why") or "requested")
            self._reply(conn, op="ack")
        elif op == "deregister":
            if agent_id:
                self._drop_entry(agent_id)
            self._reply(conn, op="ack")
        elif op == "shutdown":
            self._reply(conn, op="ack")
            self.stop()
        else:
            self._reply(conn, op="error", error="unknown-op")
        return agent_id

    # -- registry primitives ----------------------------------------

    def _register(self, conn, msg):
        agent_id = str(msg.get("id") or "anon-%d" % os.getpid())
        entry = {
            "id": agent_id,
            "name": str(msg.get("name") or agent_id),
            "role": str(msg.get("role") or "agent"),
            "parent": msg.get("parent") or None,
            "cwd": str(msg.get("cwd") or os.getcwd()),
            "session": msg.get("session") or None,
            "since_ts": time.time(),
            "last_seen": time.time(),
        }
        with self._lock:
            self._clients[agent_id] = conn
            self._registry[agent_id] = entry
        self._persist_and_notify()
        self._reply(conn, op="ack", id=agent_id)
        return agent_id

    def _snapshot(self):
        with self._lock:
            return [
                dict(entry, online=True)
                for entry in self._registry.values()
            ]

    def _persist_and_notify(self):
        with self._lock:
            data = json.dumps(
                {"ts": time.time(), "agents": self._registry}, indent=2
            )
        self.root.write_atomic(REGISTRY_NAME, data + "\n")
        self._broadcast("registry-change", self._snapshot())

    def _touch(self, agent_id):
        entry = self._registry.get(agent_id) if agent_id else None
        if entry is not None:
            entry["last_seen"] = time.time()

    def _drop_entry(self, agent_id):
        with self._lock:
            self._registry.pop(agent_id, None)
            self._clients.pop(agent_id, None)
        self._persist_and_notify()

    def _drop_conn(self, agent_id):
        if not agent_id:
            return
        with self._lock:
            conn = self._clients.get(agent_id)
            if conn is not None:
                self._clients.pop(agent_id, None)
            had_entry = agent_id in self._registry
            self._registry.pop(agent_id, None)
        if had_entry:
            self._persist_and_notify()

    # -- messaging ---------------------------------------------------

    def _relay(self, msg, sender_id, sender_conn):
        target = msg.get("to")
        with self._lock:
            conn = self._clients.get(target)
        if conn is None:
            self._reply(sender_conn, op="error", error="undeliverable",
                        target=target)
            return
        envelope = {
            "op": "message",
            "from": msg.get("from") or sender_id,
            "to": target,
            "kind": str(msg.get("kind") or "text"),
            "payload": msg.get("payload"),
            "ts": msg.get("ts") or time.time(),
        }
        self._write(conn, envelope)
        self._reply(sender_conn, op="ack")

    def _terminate(self, agent_id, why):
        with self._lock:
            conn = self._clients.get(agent_id)
        if conn is None:
            return
        self._write(conn, {
            "op": "message", "from": "*", "kind": "terminate",
            "payload": {"id": agent_id, "why": why},
        })
        self._drop_entry(agent_id)

    def _broadcast(self, kind, payload, exclude=None):
        envelope = {"op": "message", "from": "*", "kind": kind,
                    "payload": payload}
        with self._lock:
            conns = [
                c for i, c in self._clients.items()
                if i != exclude and c is not None
            ]
        for conn in conns:
            self._write(conn, envelope)

    # -- liveness ----------------------------------------------------

    def _sweep_loop(self):
        while self._running:
            time.sleep(self.sweep_interval)
            self._sweep()

    def _sweep(self):
        now = time.time()
        with self._lock:
            doomed_parent_gone = []
            doomed_idle = []
            for agent_id, entry in list(self._registry.items()):
                parent = entry.get("parent")
                if parent and parent not in self._registry:
                    doomed_parent_gone.append(agent_id)
                    continue
                if entry.get("last_seen", 0) < now - self.idle_timeout:
                    doomed_idle.append(agent_id)
            if not doomed_parent_gone and not doomed_idle:
                return
            for agent_id in doomed_parent_gone + doomed_idle:
                conn = self._clients.pop(agent_id, None)
                self._registry.pop(agent_id, None)
                if conn is not None and agent_id in doomed_parent_gone:
                    self._write(conn, {
                        "op": "message", "from": "*", "kind": "terminate",
                        "payload": {"id": agent_id, "why": "parent-gone"},
                    })
                    try:
                        conn.close()
                    except OSError:
                        pass
        self._persist_and_notify()

    # -- low-level writes -------------------------------------------

    def _reply(self, conn, **fields):
        self._write(conn, fields)

    def _write(self, conn, obj):
        try:
            conn.sendall(
                (json.dumps(obj, separators=(",", ":")) + "\n").encode()
            )
        except OSError:
            pass

    def _close_all(self):
        with self._lock:
            conns = list(self._clients.values())
            self._clients.clear()
        for conn in conns:
            try:
                conn.close()
            except OSError:
                pass


def _shutdown_via_endpoint(root):
    endpoint = root.read_endpoint()
    if not endpoint:
        raise SystemExit("teamd: no endpoint at %s" % root.base)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(2)
    try:
        sock.connect((endpoint["host"], endpoint["port"]))
        sock.sendall((
            json.dumps({"op": "hello", "token": endpoint["token"]}) + "\n"
        ).encode())
        sock.sendall((json.dumps({"op": "shutdown"}) + "\n").encode())
    except OSError as exc:
        print("teamd: %s" % exc)
        raise SystemExit(1)
    finally:
        sock.close()


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="teamd", description="pi-teams broker"
    )
    parser.add_argument("--root", default=DEFAULT_ROOT)
    parser.add_argument("--idle-timeout", type=float, default=15.0)
    parser.add_argument("--sweep-interval", type=float, default=1.0)
    parser.add_argument("command", nargs="?", choices=["start", "stop"],
                        default="start")
    args = parser.parse_args(argv)
    root = TeamRoot(args.root)
    if args.command == "stop":
        _shutdown_via_endpoint(root)
        return 0
    TeamBroker(args.root, idle_timeout=args.idle_timeout,
               sweep_interval=args.sweep_interval).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())