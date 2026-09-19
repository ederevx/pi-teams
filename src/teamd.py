#!/usr/bin/env python3
"""teamd - the pi-teams broker.

Owns a team root (default ~/.local/state/pi-teams). Agents connect over
a unix socket (teamd.sock), register once, then exchange JSON-lines
messages. The broker relays to online recipients, broadcasts registry
changes, and enforces fork lifetime: when the process that a registered
agent names as its parent dies, the broker terminates that agent, so a
fork goes away with the parent that spawned it.

Protocol (one JSON object per line, both directions):
  register/{op:id,name,role,pid,parent,cwd,session}
  send/{op,to,from,kind,payload,ts}
  broadcast/{op,kind,payload,ts}
  ls/{op}  terminate/{op,to,why}  deregister/{op}  shutdown/{op}
Reply objects use op "ack", "error", "registry", "message",
"registry-change", or "terminated".

Broker state lives on the owning TeamBroker instance only; the registry
is mirrored to disk atomically for non-connected readers.
"""

import argparse
import json
import os
import pathlib
import signal
import socket
import sys
import threading
import time

DEFAULT_ROOT = os.path.join(os.path.expanduser("~"), ".local", "state", "pi-teams")
SOCK_NAME = "teamd.sock"
REGISTRY_NAME = "registry.json"
PID_NAME = "teamd.pid"


class TeamRoot:
    """Owns the paths and atomic writes for one team root."""

    def __init__(self, root):
        self.base = pathlib.Path(root)
        self.sock = self.base / SOCK_NAME
        self.registry = self.base / REGISTRY_NAME
        self.pidfile = self.base / PID_NAME

    def ensure(self):
        self.base.mkdir(parents=True, exist_ok=True)

    def write_atomic(self, relative, data):
        self.ensure()
        target = self.base / relative
        tmp = self.base / ("%s.tmp.%d" % (relative, os.getpid()))
        tmp.write_text(data)
        try:
            os.replace(str(tmp), str(target))
        except FileNotFoundError:
            # Mirror-only write: the owning root was removed (e.g. test
            # teardown raced a lingering connection thread). The
            # in-memory registry remains authoritative.
            pass


class TeamBroker:
    """Registry + relay for connected agents on one socket."""

    def __init__(self, root=None, sweep_interval=1.0):
        self.root = TeamRoot(root or DEFAULT_ROOT)
        self.sweep_interval = sweep_interval
        self._registry = {}
        self._clients = {}
        self._lock = threading.RLock()
        self._running = False
        self._server = None

    # -- lifecycle ---------------------------------------------------

    def run(self):
        self.root.ensure()
        self._clear_stale_socket()
        self._running = True
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(str(self.root.sock))
        self._server.listen(16)
        self.root.write_atomic(PID_NAME, "%d\n" % os.getpid())
        sweeper = threading.Thread(target=self._sweep_loop, daemon=True)
        sweeper.start()
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

    def _clear_stale_socket(self):
        if not self.root.sock.exists():
            return
        holder = None
        if self.root.pidfile.exists():
            try:
                holder = int((self.root.pidfile.read_text() or "0").strip())
            except ValueError:
                holder = None
        if holder and self._alive(holder):
            raise OSError("teamd already running (pid %d) at %s"
                          % (holder, self.root.sock))
        try:
            self.root.sock.unlink()
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
                            continue
                        agent_id = self._handle(conn, msg, agent_id)
        finally:
            self._unregister_conn(agent_id)

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
        elif op == "terminate":
            self._terminate(msg.get("to"), msg.get("why") or "requested")
        elif op == "deregister":
            if agent_id:
                self._drop(agent_id)
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
        pid = msg.get("pid") or os.getpid()
        entry = {
            "id": agent_id,
            "name": str(msg.get("name") or agent_id),
            "role": str(msg.get("role") or "agent"),
            "pid": int(pid),
            "parent": msg.get("parent") or None,
            "cwd": str(msg.get("cwd") or os.getcwd()),
            "session": msg.get("session") or None,
            "since_ts": time.time(),
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
                dict(entry, online=conn is not None)
                for entry, conn in (
                    (self._registry.get(i), self._clients.get(i))
                    for i in self._registry
                )
            ]

    def _persist_and_notify(self):
        import copy
        with self._lock:
            data = json.dumps(
                {"ts": time.time(), "agents": copy.deepcopy(self._registry)},
                indent=2,
            )
        self.root.write_atomic(REGISTRY_NAME, data + "\n")
        self._broadcast("registry-change", self._snapshot())

    def _drop(self, agent_id):
        with self._lock:
            self._registry.pop(agent_id, None)
            self._clients.pop(agent_id, None)
        self._persist_and_notify()

    def _unregister_conn(self, agent_id):
        if not agent_id:
            return
        with self._lock:
            conn = self._clients.get(agent_id)
            if conn is not None:
                self._clients.pop(agent_id, None)
        if conn is not None and self._registry.get(agent_id):
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
            entry = self._registry.get(agent_id)
        if entry is None:
            return
        self._kill(entry.get("pid"))
        self._drop(agent_id)
        self._broadcast("terminated", {"id": agent_id, "why": why})

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

    def _alive(self, pid):
        try:
            os.kill(int(pid), 0)
            return True
        except (OSError, ProcessLookupError, PermissionError):
            return os.path.exists("/proc/%d" % int(pid))

    def _kill(self, pid):
        try:
            os.kill(int(pid), signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass

    def _sweep_loop(self):
        while self._running:
            time.sleep(self.sweep_interval)
            self._sweep()

    def _sweep(self):
        with self._lock:
            changed = False
            for agent_id, entry in list(self._registry.items()):
                if not self._alive(entry.get("pid")):
                    self._registry.pop(agent_id, None)
                    self._clients.pop(agent_id, None)
                    changed = True
            doomed = []
            for agent_id, entry in list(self._registry.items()):
                parent = entry.get("parent")
                if not parent:
                    continue
                parent_entry = self._registry.get(parent)
                if parent_entry is None or not self._alive(parent_entry.get("pid")):
                    doomed.append(agent_id)
        if not doomed and not changed:
            return
        for agent_id in doomed:
            self._kill(self._registry.get(agent_id, {}).get("pid"))
            self._registry.pop(agent_id, None)
            self._clients.pop(agent_id, None)
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


def _shutdown_via_socket(sock_path):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(sock_path)
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
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("start")
    sub.add_parser("stop")
    args = parser.parse_args(argv)
    root = TeamRoot(args.root)
    if args.command == "stop":
        if root.sock.exists():
            _shutdown_via_socket(str(root.sock))
        elif root.pidfile.exists():
            pid = int((root.pidfile.read_text() or "0").strip())
            os.kill(pid, signal.SIGTERM)
        else:
            print("teamd: not running at %s" % args.root)
        return 0
    TeamBroker(args.root).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())