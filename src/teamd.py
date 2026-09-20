#!/usr/bin/env python3
"""teamd - the pi-teams broker.

Serves one OS-agnostic endpoint: a loopback TCP listener on 127.0.0.1
with an ephemeral port and a random token. The address and token are
published atomically in the team root (endpoint), and every connection
must present the token in a hello handshake before any other op. Agents
register once, then exchange JSON-lines messages; the broker relays to
online recipients, mirrors the registry, and enforces fork lifetime
through connections only.

There is no pid probing for liveness: liveness is connection liveness. A
connection that closes (EOF) ends its agent; entries idle past the
heartbeat timeout are swept. When a fork's parent entry disappears, or a
fork goes idle, the broker sends that fork a terminate notice, closes
its connection, and signals the owner pid it serves (only forks carry
one). The signal is one portable SIGTERM (TerminateProcess on Windows)
the daemon sends to reap the teammate; it is never used to test whether
a pid is alive, which keeps the broker portable.

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
import signal
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
        except OSError:
            # Windows chmod only toggles the read-only bit.
            pass
        # On Windows os.replace can raise PermissionError while a reader
        # holds the destination open; retry briefly instead of failing.
        for attempt in range(11):
            try:
                os.replace(str(tmp), str(target))
                return
            except FileNotFoundError:
                # Mirror-only write: the owning root was removed (e.g. test
                # teardown raced a lingering connection thread). The
                # in-memory registry remains authoritative.
                return
            except PermissionError:
                if attempt >= 10:
                    return
                time.sleep(0.05)

    def read_endpoint(self):
        try:
            return json.loads(self.endpoint.read_text())
        except (OSError, ValueError):
            return {}


class TeamBroker:
    """Registry + relay for connected agents on one loopback endpoint."""

    def __init__(self, root=None, idle_timeout=15.0, sweep_interval=1.0,
                 fork_idle=None):
        self.root = TeamRoot(root or DEFAULT_ROOT)
        self.idle_timeout = idle_timeout
        self.sweep_interval = sweep_interval
        # A spawned teammate (role "fork") with no work contact for this
        # long is garbage-collected: its connection is closed, its
        # owner process is signalled, and its entry is dropped. Owned by
        # the broker; a busy teammate's heartbeats keep it alive.
        self.fork_idle = float(
            fork_idle if fork_idle is not None
            else os.environ.get("PI_TEAMS_FORK_IDLE", "300")
        )
        self.token = secrets.token_hex(16)
        self._registry = {}
        self._clients = {}
        self._lock = threading.RLock()
        self._running = False
        self._server = None
        self._lockpath = None

    def _acquire_lock(self):
        # One broker per root: a racing session (every hosted pi reloads
        # extensions at once, and each could start a broker) loses the
        # lock and waits for the winner's endpoint instead of binding a
        # second socket over the same root.
        lockbase = self.root.base / ".broker.lock"
        try:
            lockbase.mkdir()
        except FileExistsError:
            return False
        try:
            (lockbase / "pid").write_text("%d\n" % os.getpid())
            self._lockpath = lockbase
        except OSError:
            try:
                lockbase.rmdir()
            except OSError:
                pass
            raise
        return True

    def _release_lock(self):
        if self._lockpath is None:
            return
        try:
            (self._lockpath / "pid").unlink()
            self._lockpath.rmdir()
        except OSError:
            pass
        self._lockpath = None

    # -- lifecycle ---------------------------------------------------

    def run(self):
        self.root.ensure()
        if not self._acquire_lock():
            # Another broker owns this root; wait briefly for it to
            # publish its endpoint, then leave it to serve.
            for _ in range(15):
                if self.root.read_endpoint():
                    return
                time.sleep(0.1)
            raise OSError("teamd: broker already starting at %s"
                          % self.root.base)
        try:
            self._serve_forever()
        finally:
            self._release_lock()

    def _serve_forever(self):
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
        # Framing lives in _messages; this loop only handshakes once and
        # dispatches each parsed message.
        agent_id = None
        try:
            with conn:
                first = True
                for msg in self._messages(conn):
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

    def _messages(self, conn):
        # Yields one decoded JSON object per line until the peer closes,
        # the broker stops, or a malformed line is answered and dropped.
        conn.settimeout(0.5)
        buf = b""
        while self._running:
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                return
            if not chunk:
                return
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
                yield msg

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
            self._touch(agent_id, work=True)
        elif op == "broadcast":
            self._broadcast(msg.get("kind"), msg.get("payload"),
                            exclude=agent_id)
            self._touch(agent_id, work=True)
        elif op == "ls":
            self._reply(conn, op="registry", agents=self._snapshot())
        elif op == "ping":
            # A plain ping is the endpoint shim's keepalive; a busy ping
            # marks the agent as actively working and keeps the fork's
            # idle clock from firing. A waiting ping is not working, but
            # it is not idle either: the agent is blocked in a wait and
            # must not be reaped as idle.
            self._touch(agent_id, work=msg.get("busy") is True,
                        waiting=msg.get("waiting") is True)
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
            "owner_pid": msg.get("owner_pid") or None,
            "since_ts": time.time(),
            "last_seen": time.time(),
            "last_work": time.time(),
            "waiting": False,
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

    def _touch(self, agent_id, work=False, waiting=None):
        now = time.time()
        with self._lock:
            entry = self._registry.get(agent_id) if agent_id else None
            if entry is not None:
                entry["last_seen"] = now
                if work:
                    entry["last_work"] = now
                if waiting is not None:
                    entry["waiting"] = waiting

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

    def _evict(self, agent_id, why):
        # Drop an agent's endpoint and entry, tell its connection why, and
        # signal the fork process it serves. The caller decides whether
        # to persist: terminate does, a sweep persists once for the batch.
        with self._lock:
            entry = self._registry.get(agent_id)
            conn = self._clients.pop(agent_id, None)
            self._registry.pop(agent_id, None)
        if conn is not None:
            self._write(conn, {
                "op": "message", "from": "*", "kind": "terminate",
                "payload": {"id": agent_id, "why": why},
            })
            try:
                conn.close()
            except OSError:
                pass
        self._kill_owner(entry or {}, why)

    def _terminate(self, agent_id, why):
        self._evict(agent_id, why)
        self._persist_and_notify()

    def _kill_owner(self, entry, why):
        # GC enforcement: a spawned teammate's termination must reach the
        # pi process it serves, not just its endpoint shim. Only forks
        # ever carry an owner pid; a single portable signal works on
        # POSIX (SIGTERM) and Windows (TerminateProcess).
        if entry.get("role") != "fork":
            return
        owner = entry.get("owner_pid")
        if not owner:
            return
        try:
            os.kill(int(owner), signal.SIGTERM)
        except (OSError, ValueError):
            pass

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
        doomed_fork, doomed_idle = self._classify(time.time())
        if not doomed_fork and not doomed_idle:
            return
        for agent_id, why in doomed_fork:
            self._reap_fork(agent_id, why)
        for agent_id in doomed_idle:
            self._forget(agent_id)
        self._persist_and_notify()

    def _classify(self, now):
        # Pure policy: which agents have outlived their liveness window.
        doomed_fork = []
        doomed_idle = []
        with self._lock:
            for agent_id, entry in list(self._registry.items()):
                parent = entry.get("parent")
                parent_gone = bool(parent) and parent not in self._registry
                is_fork = entry.get("role") == "fork"
                work_idle = (
                    is_fork and self.fork_idle > 0
                    and not entry.get("waiting")
                    and entry.get("last_work", 0) < now - self.fork_idle
                )
                seen_idle = (
                    entry.get("last_seen", 0) < now - self.idle_timeout
                )
                if is_fork and (parent_gone or work_idle or seen_idle):
                    doomed_fork.append(
                        (agent_id, "parent-gone" if parent_gone else "idle-gc"))
                elif seen_idle:
                    doomed_idle.append(agent_id)
        return doomed_fork, doomed_idle

    def _reap_fork(self, agent_id, why):
        # A fork: terminate its endpoint, drop its entry, and signal the
        # pi process it serves. Only forks are ever signalled.
        self._evict(agent_id, why)

    def _forget(self, agent_id):
        with self._lock:
            self._clients.pop(agent_id, None)
            self._registry.pop(agent_id, None)

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
    parser.add_argument("--fork-idle", type=float, default=None)
    parser.add_argument("--sweep-interval", type=float, default=1.0)
    parser.add_argument("command", nargs="?", choices=["start", "stop"],
                        default="start")
    args = parser.parse_args(argv)
    root = TeamRoot(args.root)
    if args.command == "stop":
        _shutdown_via_endpoint(root)
        return 0
    TeamBroker(args.root, idle_timeout=args.idle_timeout,
               sweep_interval=args.sweep_interval,
               fork_idle=args.fork_idle).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())