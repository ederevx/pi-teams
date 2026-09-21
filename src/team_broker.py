"""Registry + relay for connected agents on one loopback endpoint.

An agent registers once, then exchanges JSON-lines messages; the broker
relays to online recipients, mirrors the registry, and enforces fork
lifetime through connections only. There is no pid probing for agent
liveness: liveness is connection liveness. A connection that closes
(EOF) ends its agent; entries idle past the heartbeat timeout are
swept. When a fork's parent entry disappears, or a fork goes idle, the
broker sends that fork a terminate notice, closes its connection, and
signals the owner pid it serves (only forks carry one).

The one exception to "no pid probing" is the broker lock: a lock left
by a crashed broker is reaped, while a live broker's lock is kept.
"""

import hashlib
import json
import os
import pathlib
import secrets
import signal
import socket
import threading
import time

from peer_link import PeerLink
from team_root import (
    DEFAULT_ROOT,
    ENDPOINT_NAME,
    PID_NAME,
    REGISTRY_NAME,
    TEAMMATE_MARKER,
    TeamRoot,
)


class TeamBroker:
    """Registry + relay for connected agents on one loopback endpoint."""

    def __init__(self, root=None, idle_timeout=15.0, sweep_interval=1.0,
                 fork_idle=None, busy_grace=None, sessions_root=None,
                 session_grace=None, restart_grace=None, peer_grace=None,
                 host=None):
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
        # Restart policy: after the on-disk source changes (an install or
        # reload), the broker exits once it has been idle this long, so the
        # replacement adopts the new code without killing live work.
        self.restart_grace = float(
            restart_grace if restart_grace is not None
            else os.environ.get("PI_TEAMS_RESTART_GRACE", "60")
        )
        # A peer link that drops (a transient ssh flap or a per-session
        # tunnel replacement) gets this long to reconnect before its
        # remote-parented forks are reaped, so a brief partition does not
        # kill forks whose parent host is still alive.
        self.peer_grace = float(
            peer_grace if peer_grace is not None
            else os.environ.get("PI_TEAMS_PEER_GRACE", "15")
        )
        self.last_active = time.time()
        self._registry = {}
        self._clients = {}
        self._peers = {}
        self._peers_by_conn = {}
        self._remote = {}
        self._peer_pending = {}
        self._peer_down_at = {}
        self._lock = threading.RLock()
        self._running = False
        self._server = None

    def _source_version(self):
        # Hash the running file so the stamp reflects the installed code.
        try:
            with open(__file__, "rb") as fh:
                return hashlib.sha256(fh.read()).hexdigest()[:16]
        except OSError:
            return ""

    # -- broker lock -------------------------------------------------

    def _remove_endpoint(self):
        # Remove only the endpoint this broker published; a newer broker may
        # have replaced it while we were stopping.
        try:
            if self.root.read_endpoint().get("token") == self.token:
                self.root.endpoint.unlink()
        except OSError:
            pass

    # -- lifecycle ---------------------------------------------------

    def run(self):
        self.root.ensure()
        if not self.root.acquire_lock():
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
            self._remove_endpoint()
            self.root.release_lock()

    def _serve_forever(self):
        self._running = True
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # Publish the socket before configuring it so a bind, listen, or
        # endpoint-publish failure still reaches the close path below
        # instead of leaking the fd.
        self._server = server
        try:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            server.listen(16)
            # A timeout lets the loop notice stop() promptly; closing a
            # listening socket does not reliably wake a blocked accept().
            server.settimeout(0.5)
            port = server.getsockname()[1]
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
            while self._running:
                try:
                    conn, _ = server.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                threading.Thread(
                    target=self._serve, args=(conn,), daemon=True
                ).start()
        finally:
            self._close_all()
            self._close_server()

    def stop(self):
        # Idempotent and safe before the server exists: a second stop, or
        # one racing broker startup, must not raise.
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
        self._close_server()

    def _close_server(self):
        server, self._server = self._server, None
        if server is not None:
            try:
                server.close()
            except OSError:
                pass

    def _maybe_restart(self, now):
        # Adopt newly installed code only once idle: a self-exit drops every
        # hold, so it must never happen while agents are working.
        if self._should_restart(now):
            self.stop()

    def _should_restart(self, now):
        # Pure policy: the on-disk source changed and the broker has been
        # idle past the grace.
        if self._source_version() == self.version:
            return False
        return now - self.last_active >= self.restart_grace

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
        # Any handled message is broker activity; the restart policy waits
        # for an idle window before adopting new code.
        self.last_active = time.time()
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
        self.root.remove_busy_file(entry)
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
            self.root.remove_busy_file(entry)
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
        self.root.remove_busy_file(entry)
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
        self._reap_expired_peers(now)
        self._gc_orphan_busy_files(now)
        if now - self._last_session_sweep >= self._session_sweep_interval:
            self._last_session_sweep = now
            self._gc_orphan_session_files(now)
        self._maybe_restart(now)
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
        self.root.remove_busy_file(entry)
        self._remove_session_file(entry)

    # -- busy-file GC ------------------------------------------------

    def _gc_orphan_busy_files(self, now):
        # A busy file is published by the extension, not the broker. One
        # whose agent is no longer registered and has not been touched for
        # the grace window belongs to an old session; remove it. A
        # registered agent (even a busy fork with an old mtime) keeps its
        # file.
        files = self.root.busy_files()
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
            self.root.unlink_under(str(path), self.root.base)

    def _gc_orphan_session_files(self, now):
        # Every teammate is a pi session that shows up in /resume. Remove
        # teammate-marked session files whose agent is not live and whose
        # mtime is older than the grace. A user's own session is never
        # marked, and a live fork's file is skipped regardless of mtime.
        # NOTE: this globs the whole sessions tree every interval; if that
        # tree ever grows past a bounded size the glob itself should become
        # incremental, but changing it risks the mtime-grace semantics.
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
                self.root.unlink_under(str(path), self.sessions_root)

    def _remove_session_file(self, entry):
        if (entry or {}).get("role") != "fork":
            return
        path = (entry or {}).get("session")
        # Only a spawned teammate's transcript is broker-owned and safe to
        # remove. An attached session carries no spawn marker and must
        # stay in /resume after the fork is reaped.
        if path and self._is_teammate_session(path):
            self.root.unlink_under(path, self.sessions_root)

    def _is_teammate_session(self, path):
        # The marker sits in the first user turn; scan only the head so a
        # large transcript is never fully read during a sweep. The scan
        # is byte-based on purpose: the locale text codec differs per
        # platform (cp1252 on Windows), and a non-ASCII session file
        # decoded through the wrong codec would raise and kill the whole
        # sweep thread.
        marker = TEAMMATE_MARKER.encode("utf-8")
        try:
            with open(path, "rb") as fh:
                for index, line in enumerate(fh):
                    if marker in line:
                        return True
                    if index >= 50:
                        break
        except OSError:
            return False
        return False

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
        now = time.time()
        with self._lock:
            if host not in self._peers:
                down_at = self._peer_down_at.get(host)
                # A link that just dropped may be a transient flap or a
                # per-session tunnel replacement; keep the fork while the
                # reconnect grace is open.
                if down_at is not None and now - down_at < self.peer_grace:
                    return False
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
                # The peer's registry is the liveness signal for its agents
                # (see _parent_gone); forcing online=False would hide live
                # remote agents from ls and from the user.
                agents.append(dict(
                    entry, online=bool(entry.get("online")), remote=True))
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
            self._peer_down_at.pop(host, None)
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
            self._peer_down_at.pop(host, None)
        try:
            peer.open()
        except OSError:
            # open() closed its own socket on failure; this link never
            # went live, so do not run it through _peer_down, which would
            # mark the host down and start the fork-reap grace.
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
            with self._lock:
                self._peer_down_at[peer.host] = time.time()

    def _reap_expired_peers(self, now):
        # A dropped peer link defers reaping for the reconnect grace; a
        # host that never comes back has its remote-parented forks reaped
        # here once the grace has passed.
        with self._lock:
            expired = [
                host for host, down_at in self._peer_down_at.items()
                if host not in self._peers
                and now - down_at >= self.peer_grace
            ]
        for host in expired:
            with self._lock:
                self._peer_down_at.pop(host, None)
            self._reap_peer(host)

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
        # Garbage-collect persisted peers that no longer open: their
        # loopback tunnel is owned by an extension, so an entry that
        # cannot reconnect is dead weight, not a peer to retry forever.
        self._persist_peers()

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
        # Shutdown must leave nothing reachable behind: clear the relay
        # clients and every map that holds entries, peers, remote views,
        # or pending relays. Pending senders are answered before their
        # connections close so a shutdown never strands a request.
        with self._lock:
            conns = list(self._clients.values())
            pending = list(self._peer_pending.values())
            peers = list(self._peers.values())
            self._clients.clear()
            self._registry.clear()
            self._peer_pending.clear()
            self._remote.clear()
            self._peer_down_at.clear()
            self._peers.clear()
            self._peers_by_conn.clear()
        for entry in pending:
            self._reply(entry[0], op="error", error="undeliverable")
        for conn in conns:
            try:
                conn.close()
            except OSError:
                pass
        for peer in peers:
            peer.drop()