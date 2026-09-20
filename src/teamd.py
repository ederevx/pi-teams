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
  register/{op,id,name,role,parent,cwd,session,busy_file}
  send/{op,to,from,kind,payload,ts}  ping/{op}  ls/{op}
  terminate/{op,to,why}        deregister/{op}  shutdown/{op}
Reply objects use op "ack", "error", "registry", "message",
"registry-change", or "terminated". Notices use kind "terminate".
"""

import argparse
import hashlib
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
PEERS_NAME = "peers.json"
BUSY_SUFFIX = ".busy"
# The extension's spawn prompt marks a forked teammate session; the broker
# uses it to tell teammate sessions apart from a user's own sessions.
TEAMMATE_MARKER = "a teammate spawned by a parent pi session"


class TeamRoot:
    """Owns the paths and atomic writes for one team root."""

    def __init__(self, root):
        self.base = pathlib.Path(root)
        self.endpoint = self.base / ENDPOINT_NAME
        self.registry = self.base / REGISTRY_NAME
        self.pidfile = self.base / PID_NAME
        self.peersfile = self.base / PEERS_NAME

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

    def read_peers(self):
        try:
            data = json.loads(self.peersfile.read_text())
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def write_peers(self, peers):
        self.write_atomic(PEERS_NAME, json.dumps(peers, indent=2) + "\n")


class PeerLink:
    """One broker's authenticated, bidirectional link to a peer broker.

    Either side may open it: the initiator connects and starts a read
    loop; the acceptor wraps the accepted socket and lets the caller's
    connection loop feed it. Both directions carry peer-relay traffic
    and peer-registry snapshots over a single stream.
    """

    def __init__(self, owner, host, endpoint=None, conn=None):
        self.owner = owner
        self.host = host
        self.endpoint = endpoint or {}
        self.conn = conn
        self.connected = conn is not None
        self._buf = b""
        self._send_lock = threading.Lock()
        self._drop_lock = threading.Lock()

    def open(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2.0)
        sock.connect((self.endpoint["host"], self.endpoint["port"]))
        sock.settimeout(0.5)
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


class TeamBroker:
    """Registry + relay for connected agents on one loopback endpoint."""

    def __init__(self, root=None, idle_timeout=15.0, sweep_interval=1.0,
                 fork_idle=None, busy_grace=None, sessions_root=None,
                 session_grace=None, host=None):
        self.root = TeamRoot(root or DEFAULT_ROOT)
        self.idle_timeout = idle_timeout
        self.sweep_interval = sweep_interval
        # Globally unique ids need a per-host label; peers route by the
        # host prefix of a target id.
        self.host = host or os.environ.get("PI_TEAMS_HOST") \
            or socket.gethostname().split(".")[0]
        # A spawned teammate (role "fork") with no work contact for this
        # long is garbage-collected: its connection is closed, its
        # owner process is signalled, and its entry is dropped. Owned by
        # the broker; a busy teammate's heartbeats keep it alive.
        self.fork_idle = float(
            fork_idle if fork_idle is not None
            else os.environ.get("PI_TEAMS_FORK_IDLE", "300")
        )
        # A .busy file whose agent is no longer registered and whose mtime
        # is older than this grace belongs to an old session (a reload,
        # crash, or reaped fork); the orphan sweep removes it. Registered
        # agents keep their file however old its mtime is.
        self.busy_grace = float(
            busy_grace if busy_grace is not None
            else os.environ.get("PI_TEAMS_BUSY_GRACE", "120")
        )
        # A teammate's pi session file is removed when the fork is reaped,
        # and any teammate-marked session file whose agent is not live and
        # whose mtime is older than this grace is swept. This keeps old
        # forks out of pi's /resume list.
        agent_dir = os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(
            os.path.expanduser("~"), ".pi", "agent")
        self.sessions_root = pathlib.Path(
            sessions_root or os.environ.get("PI_TEAMS_SESSIONS_ROOT")
            or os.path.join(agent_dir, "sessions")
        )
        self.session_grace = float(
            session_grace if session_grace is not None
            else os.environ.get("PI_TEAMS_SESSION_GRACE", "3600")
        )
        self._session_sweep_interval = float(
            os.environ.get("PI_TEAMS_SESSION_SWEEP_INTERVAL", "300")
        )
        self._last_session_sweep = 0.0
        self.token = secrets.token_hex(16)
        # Stamp the running source so a reloading extension can tell a
        # broker built from older code from the installed one and restart
        # it. The stamp is the installed file's own hash.
        self.version = self._source_version()
        self._registry = {}
        self._clients = {}
        self._peers = {}
        self._peers_by_conn = {}
        self._remote = {}
        self._peer_pending = {}
        self._lock = threading.RLock()
        self._running = False
        self._server = None
        self._lockpath = None

    def _source_version(self):
        # Hash the running file so the stamp reflects the installed code.
        try:
            with open(__file__, "rb") as fh:
                return hashlib.sha256(fh.read()).hexdigest()[:16]
        except OSError:
            return ""

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
        # A timeout lets the loop notice stop() promptly; closing a
        # listening socket does not reliably wake a blocked accept().
        self._server.settimeout(0.5)
        port = self._server.getsockname()[1]
        self.root.write_atomic(
            ENDPOINT_NAME,
            json.dumps(
                {"host": "127.0.0.1", "port": port,
                 "token": self.token, "name": self.host,
                 "version": self.version},
                indent=2,
            )
            + "\n",
            mode=0o600,
        )
        self.root.write_atomic(PID_NAME, "%d\n" % os.getpid())
        threading.Thread(target=self._sweep_loop, daemon=True).start()
        self._load_peers()
        try:
            while self._running:
                try:
                    conn, _ = self._server.accept()
                except socket.timeout:
                    continue
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
        # Close peer links here as well as in _close_all: closing the
        # listening socket does not reliably wake a blocked accept(), so
        # the serve loop's finally may not run promptly. Dropping the
        # link now sends the peer an EOF and drives connection-based GC.
        with self._lock:
            peers = list(self._peers.values())
        for peer in peers:
            peer.endpoint = {}
            peer.drop()
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
            with self._lock:
                peer = self._peers_by_conn.pop(conn, None)
            if peer is not None:
                peer.drop()
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
            self._reply(conn, op="registry", agents=self._snapshot_all())
        elif op == "peer":
            self._accept_peer(conn, str(msg.get("host") or ""))
            self._reply(conn, op="ack")
        elif op in ("peer-registry", "peer-relay", "peer-ack"):
            peer = self._peer_for(conn)
            if peer is not None:
                peer.feed(msg)
        elif op == "peer-add":
            ok = self.link_peer(str(msg.get("host") or ""),
                               msg.get("endpoint") or {})
            if ok:
                self._reply(conn, op="ack")
            else:
                self._reply(conn, op="error", error="peer-unreachable")
        elif op == "peer-remove":
            self._remove_peer(str(msg.get("host") or ""))
            self._reply(conn, op="ack")
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
            "busy_file": msg.get("busy_file") or None,
            "origin": self.host,
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
            peers = list(self._peers.values())
        self.root.write_atomic(REGISTRY_NAME, data + "\n")
        agents = self._snapshot()
        self._broadcast("registry-change", agents)
        for peer in peers:
            peer.send({"op": "peer-registry", "agents": agents})

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
            entry = self._registry.pop(agent_id, None)
            self._clients.pop(agent_id, None)
        self._remove_busy_file(entry)
        self._remove_session_file(entry)
        self._persist_and_notify()

    def _drop_conn(self, agent_id):
        if not agent_id:
            return
        with self._lock:
            conn = self._clients.get(agent_id)
            if conn is not None:
                self._clients.pop(agent_id, None)
            entry = self._registry.pop(agent_id, None)
            had_entry = entry is not None
        if had_entry:
            self._remove_busy_file(entry)
            self._persist_and_notify()

    # -- messaging ---------------------------------------------------

    def _relay(self, msg, sender_id, sender_conn):
        target = msg.get("to")
        with self._lock:
            conn = self._clients.get(target)
        if conn is not None:
            self._write(conn, {
                "op": "message",
                "from": msg.get("from") or sender_id,
                "to": target,
                "kind": str(msg.get("kind") or "text"),
                "payload": msg.get("payload"),
                "ts": msg.get("ts") or time.time(),
            })
            self._reply(sender_conn, op="ack")
            return
        peer = self._peers.get(self._parent_host(target))
        if peer is not None and peer.connected:
            rid = secrets.token_hex(8)
            with self._lock:
                self._peer_pending[rid] = (sender_conn, peer, time.time())
            sent = peer.send({
                "op": "peer-relay", "id": rid, "to": target,
                "from": msg.get("from") or sender_id,
                "kind": str(msg.get("kind") or "text"),
                "payload": msg.get("payload"),
                "ts": msg.get("ts") or time.time(),
            })
            if sent:
                return
            with self._lock:
                self._peer_pending.pop(rid, None)
        self._reply(sender_conn, op="error", error="undeliverable",
                    target=target)

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
        self._remove_busy_file(entry)
        self._remove_session_file(entry)
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
        now = time.time()
        self._expire_peer_relays()
        self._gc_orphan_busy_files(now)
        if now - self._last_session_sweep >= self._session_sweep_interval:
            self._last_session_sweep = now
            self._gc_orphan_session_files(now)
        doomed_fork, doomed_idle = self._classify(now)
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
                parent_gone = self._parent_gone(parent)
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
        # An idle non-fork is dropped and its socket closed so the serve
        # thread ends instead of looping on an open connection forever.
        with self._lock:
            conn = self._clients.pop(agent_id, None)
            entry = self._registry.pop(agent_id, None)
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass
        self._remove_busy_file(entry)
        self._remove_session_file(entry)

    # -- busy-file GC ------------------------------------------------

    def _gc_orphan_busy_files(self, now):
        # A busy file is published by the extension, not the broker. One
        # whose agent is no longer registered and has not been touched for
        # the grace window belongs to an old session; remove it. A
        # registered agent (even a busy fork with an old mtime) keeps its
        # file.
        try:
            files = list(self.root.base.glob("*" + BUSY_SUFFIX))
        except OSError:
            return
        with self._lock:
            live = {
                str(pathlib.Path(entry["busy_file"]).resolve())
                for entry in self._registry.values()
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
            self._unlink_under(str(path), self.root.base)

    def _remove_busy_file(self, entry):
        path = (entry or {}).get("busy_file")
        if path:
            self._unlink_under(path, self.root.base)

    def _gc_orphan_session_files(self, now):
        # Every teammate is a pi session that shows up in /resume. Remove
        # teammate-marked session files whose agent is not live and whose
        # mtime is older than the grace. A user's own session is never
        # marked, and a live fork's file is skipped regardless of mtime.
        try:
            files = list(self.sessions_root.glob("**/*.jsonl"))
        except OSError:
            return
        with self._lock:
            live = {
                str(pathlib.Path(entry["session"]).resolve())
                for entry in self._registry.values()
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
            if self._is_teammate_session(path):
                self._unlink_under(str(path), self.sessions_root)

    def _remove_session_file(self, entry):
        if (entry or {}).get("role") != "fork":
            return
        path = (entry or {}).get("session")
        if path:
            self._unlink_under(path, self.sessions_root)

    def _is_teammate_session(self, path):
        # The marker sits in the first user turn; scan only the head so a
        # large transcript is never fully read during a sweep.
        try:
            with open(path) as fh:
                for index, line in enumerate(fh):
                    if TEAMMATE_MARKER in line:
                        return True
                    if index >= 50:
                        break
        except OSError:
            return False
        return False

    def _unlink_under(self, path, root):
        # Guard a delete to the root that owns the file; a path outside it
        # is never removed.
        try:
            target = pathlib.Path(path).resolve()
            base = pathlib.Path(root).resolve()
            if base != target.parent and base not in target.parents:
                return
            target.unlink()
        except OSError:
            pass

    # -- peer federation ---------------------------------------------

    def _parent_host(self, agent_id):
        # The host prefix on an agent id, or our own host for a bare local
        # id. Routing and cross-host parentage both use this.
        if isinstance(agent_id, str) and ":" in agent_id:
            return agent_id.split(":", 1)[0]
        return self.host

    def _parent_gone(self, parent):
        # A parent is gone when it is neither a live local entry nor a
        # live agent on a connected peer. For a peer parent the peer's
        # registry snapshot is the liveness signal, so a remote fork is
        # reaped when its requesting agent disconnects, not only when the
        # whole peer link drops.
        if not parent:
            return False
        if parent in self._registry:
            return False
        host = self._parent_host(parent)
        if host == self.host:
            return True
        with self._lock:
            if host not in self._peers:
                return True
            agents = self._remote.get(host)
        if agents is None:
            return False
        return not any(a.get("id") == parent for a in agents)

    def _snapshot_all(self):
        agents = self._snapshot()
        with self._lock:
            remote = list(self._remote.items())
        for host, entries in remote:
            for entry in entries:
                agents.append(dict(entry, online=False, remote=True))
        return agents

    def _peer_for(self, conn):
        with self._lock:
            return self._peers_by_conn.get(conn)

    def _accept_peer(self, conn, host):
        if not host or host == self.host:
            return
        peer = PeerLink(self, host, conn=conn)
        with self._lock:
            old = self._peers.get(host)
            self._peers[host] = peer
            self._peers_by_conn[conn] = peer
        if old is not None and old is not peer and old.connected:
            old.drop()
        peer.send({"op": "peer-registry", "agents": self._snapshot()})

    def link_peer(self, host, endpoint, persist=True):
        if not host or host == self.host or not endpoint:
            return False
        with self._lock:
            existing = self._peers.get(host)
        if existing is not None and existing.connected:
            return True
        peer = PeerLink(self, host, endpoint=endpoint)
        with self._lock:
            self._peers[host] = peer
        try:
            peer.open()
        except OSError:
            with self._lock:
                self._peers.pop(host, None)
            return False
        peer.send({"op": "peer-registry", "agents": self._snapshot()})
        if persist:
            self._persist_peers()
        return True

    def _remove_peer(self, host):
        with self._lock:
            peer = self._peers.get(host)
        if peer is not None:
            # Drop in place so _peer_down still sees it as current and
            # reaps that host's forks and pending relays.
            peer.endpoint = {}
            peer.drop()
        else:
            with self._lock:
                self._remote.pop(host, None)
        self._persist_peers()

    def _peer_message(self, peer, msg):
        op = msg.get("op")
        if op == "peer-registry":
            with self._lock:
                self._remote[peer.host] = msg.get("agents") or []
        elif op == "peer-relay":
            self._deliver_peer(peer, msg)
        elif op == "peer-ack":
            self._finish_peer_relay(peer, msg)

    def _deliver_peer(self, peer, msg):
        target = msg.get("to")
        with self._lock:
            conn = self._clients.get(target)
        if conn is not None:
            self._write(conn, {
                "op": "message",
                "from": msg.get("from") or peer.host,
                "to": target,
                "kind": str(msg.get("kind") or "text"),
                "payload": msg.get("payload"),
                "ts": msg.get("ts") or time.time(),
            })
        peer.send({"op": "peer-ack", "id": msg.get("id"),
                   "ok": conn is not None})

    def _finish_peer_relay(self, peer, msg):
        # Only the peer the relay went to may answer it; another peer's
        # ack must not clear a different host's pending relay.
        rid = msg.get("id")
        with self._lock:
            entry = self._peer_pending.get(rid)
            if entry is None or entry[1] is not peer:
                return
            del self._peer_pending[rid]
        sender = entry[0]
        if msg.get("ok"):
            self._reply(sender, op="ack")
        else:
            self._reply(sender, op="error", error="undeliverable")

    def _peer_down(self, peer):
        # A replaced link must not reap live forks: only the current link
        # owns its host's remote view and reaping. Pending relays are
        # keyed by identity, so they are purged for every dropped link.
        with self._lock:
            was_current = self._peers.get(peer.host) is peer
            if was_current:
                self._peers.pop(peer.host, None)
                self._remote.pop(peer.host, None)
            for conn, other in list(self._peers_by_conn.items()):
                if other is peer:
                    self._peers_by_conn.pop(conn, None)
            stale = [
                (rid, entry)
                for rid, entry in self._peer_pending.items()
                if entry[1] is peer
            ]
            for rid, _entry in stale:
                self._peer_pending.pop(rid, None)
        for _rid, entry in stale:
            self._reply(entry[0], op="error", error="undeliverable")
        if was_current:
            self._reap_peer(peer.host)

    def _expire_peer_relays(self):
        # A peer that never answers must not leak the pending relay or
        # hang the sender: answer undeliverable after the idle window.
        now = time.time()
        with self._lock:
            stale = [
                (rid, entry)
                for rid, entry in self._peer_pending.items()
                if now - entry[2] > self.idle_timeout
            ]
            for rid, _entry in stale:
                self._peer_pending.pop(rid, None)
        for _rid, entry in stale:
            self._reply(entry[0], op="error", error="undeliverable")

    def _reap_peer(self, host):
        doomed = []
        with self._lock:
            for agent_id, entry in list(self._registry.items()):
                if entry.get("role") != "fork":
                    continue
                if self._parent_host(entry.get("parent")) == host:
                    doomed.append(agent_id)
        for agent_id in doomed:
            self._evict(agent_id, "parent-gone")
        if doomed:
            self._persist_and_notify()

    def _load_peers(self):
        for host, endpoint in self.root.read_peers().items():
            self.link_peer(host, endpoint, persist=False)

    def _persist_peers(self):
        with self._lock:
            endpoints = {
                host: peer.endpoint
                for host, peer in self._peers.items()
                if peer.endpoint
            }
        self.root.write_peers(endpoints)

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
            peers = list(self._peers.values())
            self._peers.clear()
            self._peers_by_conn.clear()
        for conn in conns:
            try:
                conn.close()
            except OSError:
                pass
        for peer in peers:
            peer.drop()


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
    parser.add_argument("--host", default=None)
    parser.add_argument("--idle-timeout", type=float, default=15.0)
    parser.add_argument("--fork-idle", type=float, default=None)
    parser.add_argument("--busy-grace", type=float, default=None)
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
               fork_idle=args.fork_idle, busy_grace=args.busy_grace,
               host=args.host).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())