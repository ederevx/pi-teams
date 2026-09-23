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

from delivery import MailboxDelivery
from mailbox import Mailbox
from registry import RegistryMirror

from finish_query import FinishQueries
from peer_link import PeerLink
from send_gate import SendGate
from peer_transport import PeerTransport
from state_gc import StateGc
from peer_tunnel import PeerTunnel, PeerUnreachable
from team_root import (
    DEFAULT_ROOT,
    ENDPOINT_NAME,
    PID_NAME,
    REGISTRY_NAME,
    TeamRoot,
)


class TeamBroker:
    """Registry + relay for connected agents on one loopback endpoint."""

    def __init__(self, root=None, idle_timeout=15.0, sweep_interval=1.0,
                 fork_idle=None, busy_grace=None, sessions_root=None,
                 session_grace=None, restart_grace=None, peer_grace=None,
                 gc_ping_grace=None, host=None, tunnel_factory=None):
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
        # write_atomic leaves a .tmp.<pid> scratch only when every
        # rename retry failed; sweep those aged leftovers on this
        # cadence so one crashed write cannot litter the root.
        self.tmp_sweep_interval = 3600.0
        self._last_tmp_sweep = 0.0
        # Before an idle fork is reaped it is asked whether it is done:
        # a query goes to its client, which answers at once when the
        # teammate is busy or surfaces the question to its agent, and
        # the fork is spared while this grace is open. Zero disables the
        # query and reaps immediately, as earlier versions did. State
        # (which queries are outstanding, when they expire) lives in the
        # FinishQueries owner.
        self.gc_ping_grace = float(
            gc_ping_grace if gc_ping_grace is not None
            else os.environ.get("PI_TEAMS_GC_PING_GRACE", "60")
        )
        self._finish_queries = FinishQueries(self.gc_ping_grace)
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
        # Member gating: one send token per registration, checked on
        # the ops that can speak for an agent (see send_gate.py).
        self._send_gate = SendGate()
        self._peers = {}
        self._peers_by_conn = {}
        self._remote = {}
        self._peer_pending = {}
        self._peer_down_at = {}
        # SSH transport owned through the PeerTransport collaborator: a
        # live tunnel per label, the durable label -> ssh config, and
        # which tunnel opened each host's outbound link. The injected
        # factory keeps ssh out of unit tests.
        self.transport = PeerTransport(
            self.host, tunnel_factory=tunnel_factory)
        self.transport.persist = self._persist_peers
        # Store-and-forward owner: messages for a target whose hold is
        # restarting are parked on disk and replayed on re-register.
        self.delivery = MailboxDelivery(Mailbox(self.root))
        # The registry's derived views: computed online snapshot plus
        # the cadence-written registry.json mirror.
        self.mirror = RegistryMirror(
            self.root, self._registry, self.idle_timeout)
        self._lock = threading.RLock()
        self.state_gc = StateGc(
            self.root, self._registry, self._lock,
            self.sessions_root, self.session_grace, self.busy_grace)
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
            peer.drop_in_place()
        self._close_tunnels()
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
            kind = str(msg.get("kind") or "text")
            if kind in ("finish-yes", "finish-no"):
                self._handle_finish_answer(agent_id, kind, conn)
                return agent_id
            # The asserted sender is the envelope's from: a transient
            # client (the extension's own team.py runs) presents its
            # agent's token without holding a connection.
            if not self._send_gate.check(
                    str(msg.get("from") or agent_id or ""),
                    msg.get("send_token")):
                self._reply(conn, op="error", error="send-token",
                            detail=SendGate.refused_reason())
            else:
                self.dispatch(msg, agent_id, conn)
                self._touch(agent_id, work=True)
        elif op == "broadcast":
            if not self._send_gate.check(
                    str(msg.get("from") or agent_id or ""),
                    msg.get("send_token")):
                self._reply(conn, op="error", error="send-token",
                            detail=SendGate.refused_reason())
            else:
                self._broadcast(msg.get("kind"), msg.get("payload"),
                                exclude=agent_id)
                self._touch(agent_id, work=True)
        elif op == "ls":
            self._reply(conn, op="registry", agents=self._snapshot_all(),
                        peers=self.peer_list())
        elif op == "peer":
            self._accept_peer(conn, str(msg.get("host") or ""))
            self._reply(conn, op="ack")
        elif op in ("peer-registry", "peer-relay", "peer-ack",
                    "peer-control"):
            peer = self._peer_for(conn)
            if peer is not None:
                peer.feed(msg)
        elif op == "peer-add":
            try:
                result = self.add_peer(str(msg.get("label") or ""),
                                       str(msg.get("ssh") or ""))
            except PeerUnreachable as err:
                self._reply(conn, op="error", error="peer-unreachable",
                            detail=err.detail, setup=err.setup)
            else:
                self._reply(conn, op="ack", **result)
        elif op == "peer-remove":
            self.remove_peer(str(msg.get("label") or ""))
            self._reply(conn, op="ack")
        elif op == "peer-list":
            self._reply(conn, op="peers", peers=self.peer_list())
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
            self.terminate(msg.get("to"), msg.get("why") or "requested",
                           conn)
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
            "attached": bool(msg.get("attached")),
            "origin": self.host,
            "since_ts": time.time(),
            "last_seen": time.time(),
            "last_work": time.time(),
            "waiting": False,
        }
        with self._lock:
            stale = [
                (old_id, self._registry[old_id])
                for old_id in self._stale_same_owner(agent_id, entry)
            ]
            for old_id, _ in stale:
                self._registry.pop(old_id, None)
                self._clients.pop(old_id, None)
                self._send_gate.drop(old_id)
                self.delivery.mark_dropped(old_id)
            self._clients[agent_id] = conn
            self._registry[agent_id] = entry
            self._send_gate.issue(agent_id, msg.get("send_token"))
        for old_id, old_entry in stale:
            self._finish_queries.close(old_id)
            self.root.remove_busy_file(old_entry)
            self.state_gc.remove_session_file(old_entry)
        self._persist_and_notify()
        self._reply(conn, op="ack", id=agent_id)
        self.delivery.replay(
            agent_id, lambda envelope: self._write(conn, envelope))
        return agent_id

    def _stale_same_owner(self, agent_id, entry):
        # One registration per live session: a hold restart or reload
        # that re-registers under a fresh id but with the same owner
        # pid and session file replaces the stale entry instead of
        # leaving a second identity for the same session. Only a
        # same-session duplicate qualifies, so a pid reused by an
        # unrelated session never collides here. The registering
        # connection wins; a reloaded-away instance stops re-registering
        # because its replacement handed its identity over.
        stale = []
        if not (entry.get("owner_pid") and entry.get("session")):
            return stale
        for other_id, other in self._registry.items():
            if other_id == agent_id:
                continue
            if other.get("owner_pid") and other.get("session") \
                    and str(other["owner_pid"]) == str(entry["owner_pid"]) \
                    and other["session"] == entry["session"]:
                stale.append(other_id)
        return stale

    def _snapshot(self):
        now = time.time()
        with self._lock:
            return self.mirror.snapshot(now)

    def _persist_and_notify(self):
        with self._lock:
            data = self.mirror.render(time.time())
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
            due = False
            if entry is not None:
                entry["last_seen"] = now
                if work:
                    entry["last_work"] = now
                if waiting is not None:
                    entry["waiting"] = waiting
                due = self.mirror.due(now)
                data = self.mirror.render(now) if due else None
        if due:
            self.root.write_atomic(REGISTRY_NAME, data + "\n")

    def _drop_entry(self, agent_id):
        with self._lock:
            entry = self._registry.pop(agent_id, None)
            self._clients.pop(agent_id, None)
            self._send_gate.drop(agent_id)
        self._finish_queries.close(agent_id)
        self.root.remove_busy_file(entry)
        self.state_gc.remove_session_file(entry)
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
            self._send_gate.drop(agent_id)
            if had_entry:
                # A connection loss is not an eviction: mark the drop
                # so sends during the hold-restart gap park in the
                # mailbox instead of failing outright.
                self.delivery.mark_dropped(agent_id)
        if had_entry:
            self.root.remove_busy_file(entry)
            self._persist_and_notify()

    # -- messaging ---------------------------------------------------

    def _envelope(self, from_id, kind, payload, to=None, ts=None):
        # One owner for the wire envelope every delivered message wears.
        # The id lets a client filter redeliveries (mailbox drain after
        # a crash between delivery and unlink) from fresh traffic.
        return {
            "op": "message",
            "id": secrets.token_hex(8),
            "from": from_id,
            "to": to,
            "kind": str(kind or "text"),
            "payload": payload,
            "ts": ts or time.time(),
        }

    def dispatch(self, msg, sender_id, sender_conn):
        target = msg.get("to")
        envelope = self._envelope(
            msg.get("from") or sender_id,
            msg.get("kind"), msg.get("payload"),
            to=target, ts=msg.get("ts"),
        )
        with self._lock:
            conn = self._clients.get(target)
        if conn is not None:
            self._write(conn, envelope)
            self._reply(sender_conn, op="ack")
            return
        # A local target whose connection dropped recently still
        # belongs to the team: park the message and ack, so the
        # hold-restart window loses nothing. The sweep drops what
        # outlives the mailbox ttl.
        if self._parent_host(target) == self.host \
                and self.delivery.accepts(
                    target, target in self._registry):
            self.delivery.park(target, envelope)
            self._reply(sender_conn, op="ack", queued=True)
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
            self._send_gate.drop(agent_id)
        self._finish_queries.close(agent_id)
        if conn is not None:
            self._write(conn, self._envelope(
                "*", "terminate", {"id": agent_id, "why": why}))
            try:
                conn.close()
            except OSError:
                pass
        self.root.remove_busy_file(entry)
        self.state_gc.remove_session_file(entry)
        self._kill_owner(entry or {}, why)

    def _terminate(self, agent_id, why):
        self._evict(agent_id, why)
        self._persist_and_notify()

    def terminate(self, target, why, conn=None):
        """Evict a local agent, or ask its host's broker to evict it, and
        answer the requester once. One entry point for local and peer."""
        if self._parent_host(target) == self.host:
            self._terminate(target, why)
            if conn is not None:
                self._reply(conn, op="ack")
            return
        peer = self._peers.get(self._parent_host(target))
        if peer is None or not peer.connected:
            if conn is not None:
                self._reply(conn, op="error", error="undeliverable",
                            target=target)
            return
        rid = secrets.token_hex(8)
        with self._lock:
            self._peer_pending[rid] = (conn, peer, time.time())
        sent = peer.send({"op": "peer-control", "id": rid,
                          "action": "terminate", "to": target, "why": why})
        if not sent:
            with self._lock:
                self._peer_pending.pop(rid, None)
            if conn is not None:
                self._reply(conn, op="error", error="undeliverable",
                            target=target)

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
        envelope = self._envelope("*", kind, payload)
        with self._lock:
            conns = [
                c for i, c in self._clients.items()
                if i != exclude and c is not None
            ]
        for conn in conns:
            self._write(conn, envelope)

    # -- liveness ----------------------------------------------------

    def _handle_finish_answer(self, agent_id, kind, conn):
        # A finish query's answer arrives as a relayed message whose kind
        # carries the answer. "yes" says still working: drop the query
        # and give the idle clock a fresh window before asking again.
        # "no" says done: reap now instead of waiting out the grace on
        # mere silence. Only these two kinds reach here.
        if kind == "finish-yes":
            if agent_id:
                self._finish_queries.close(agent_id)
                self._touch(agent_id, work=True)
        elif kind == "finish-no":
            if agent_id and \
                    self._registry.get(agent_id, {}).get("role") == "fork":
                self._reap_fork(agent_id, "finished")
                self._persist_and_notify()
        self._reply(conn, op="ack")

    def _sweep_loop(self):
        while self._running:
            time.sleep(self.sweep_interval)
            self._sweep()

    def _sweep(self):
        now = time.time()
        self._expire_peer_relays()
        self._reap_expired_peers(now)
        self.state_gc.gc_orphan_busy_files(now)
        if now - self._last_tmp_sweep >= self.tmp_sweep_interval:
            self._last_tmp_sweep = now
            self.root.gc_tmp_files(now, self.busy_grace)
        if now - self._last_session_sweep >= self._session_sweep_interval:
            self._last_session_sweep = now
            self.state_gc.gc_orphan_session_files(now)
        self.delivery.prune(now)
        self._maybe_restart(now)
        doomed_fork, doomed_idle = self._classify(now)
        if not doomed_fork and not doomed_idle:
            self._finish_queries.expired(now)
            return
        # An idle fork is asked whether it is done before it is reaped;
        # only silence (or a done answer) past the grace proceeds. A
        # parent-gone fork loses its owner at once, so a query cannot
        # save it and none is sent.
        asked = self._ask_idle_forks(doomed_fork, now)
        for agent_id, why in doomed_fork:
            if agent_id in asked:
                continue
            self._reap_fork(agent_id, why)
        for agent_id in doomed_idle:
            self._forget(agent_id)
        self._finish_queries.expired(now)
        self._persist_and_notify()

    def _ask_idle_forks(self, doomed_fork, now):
        # Sends a finish query to each work-idle fork whose grace is not
        # open yet and marks the query outstanding; returns the set of
        # agent ids that must not be reaped this sweep because their
        # answer window is open. A parent-gone fork is never asked: its
        # team is gone, so a continue answer has no one to return to.
        asked = set()
        if not self._finish_queries.enabled:
            return asked
        for agent_id, why in doomed_fork:
            if why != "idle-gc" or \
                    agent_id in self._finish_queries.ids():
                continue
            entry = self._registry.get(agent_id)
            if entry is None:
                continue
            conn = self._clients.get(agent_id)
            if conn is None:
                continue
            self._write(conn, self._envelope(
                "*", "finish?", {"id": agent_id, "why": "idle-gc"}))
            self._finish_queries.open(agent_id, now)
        for agent_id in self._finish_queries.ids():
            if self._finish_queries.is_open(agent_id, now):
                asked.add(agent_id)
        return asked

    def _classify(self, now):
        # Pure policy: which agents have outlived their liveness window.
        doomed_fork = []
        doomed_idle = []
        with self._lock:
            for agent_id, entry in list(self._registry.items()):
                parent = entry.get("parent")
                parent_gone = self._parent_gone(parent)
                is_fork = entry.get("role") == "fork"
                # An attached session keeps the parent-gone lifetime but
                # not the fork-idle one: it was a live session the user
                # chose to attach, not a process spawned for one task.
                work_idle = (
                    is_fork and self.fork_idle > 0
                    and not entry.get("attached")
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
            self._send_gate.drop(agent_id)
            if entry is not None:
                self.delivery.mark_dropped(agent_id)
        self._finish_queries.close(agent_id)
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass
        self.root.remove_busy_file(entry)
        self.state_gc.remove_session_file(entry)

    # -- busy-file GC ------------------------------------------------

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
        # Both hosts may race an outbound tunnel to each other. Keep the
        # deterministic winner (the lexicographically smaller host sends)
        # so the pair settles on one link instead of flapping.
        if self.host < host and self._tunnel_for(host) is not None:
            try:
                conn.close()
            except OSError:
                pass
            return
        peer = PeerLink(self, host, conn=conn)
        with self._lock:
            old = self._peers.get(host)
            self._peers[host] = peer
            self._peers_by_conn[conn] = peer
            self._peer_down_at.pop(host, None)
        self.transport.clear_owner(host, None)
        if old is not None and old is not peer and old.connected:
            old.drop()
        # Our own outbound tunnel to this host is now redundant. Close it
        # without dropping the inbound link we just installed: ownership
        # is already cleared, so _tunnel_down will not remove the link.
        redundant = self._tunnel_for(host)
        if redundant is not None and self.host > host:
            # Keep the durable config: the label stays a known peer even
            # though the inbound link now serves the host.
            self.transport.forget_tunnel(redundant)
            redundant.close()
        peer.send({"op": "peer-registry", "agents": self._snapshot()})

    def link_peer(self, host, endpoint, persist=True, replace=False):
        if not host or host == self.host or not endpoint:
            return False
        with self._lock:
            existing = self._peers.get(host)
        if existing is not None and existing.connected and not replace:
            return True
        peer = PeerLink(self, host, endpoint=endpoint)
        try:
            peer.open()
        except OSError:
            # open() closed its own socket on failure; this link never
            # went live, so do not run it through _peer_down, which would
            # mark the host down and start the fork-reap grace. A failed
            # replacement must leave any working link in place.
            return False
        with self._lock:
            old = self._peers.get(host)
            self._peers[host] = peer
            self._peer_down_at.pop(host, None)
        if old is not None and old is not peer and old.connected:
            old.drop()
        peer.send({"op": "peer-registry", "agents": self._snapshot()})
        if persist:
            self._persist_peers()
        return True

    def _remove_peer(self, host, reap=False):
        with self._lock:
            peer = self._peers.get(host)
        if peer is not None:
            # Drop in place so _peer_down still sees it as current and
            # reaps that host's forks and pending relays.
            peer.drop_in_place()
        else:
            with self._lock:
                self._remote.pop(host, None)
        if reap:
            with self._lock:
                self._peer_down_at.pop(host, None)
            self._reap_peer(host)
        self._persist_peers()

    # -- broker-owned ssh transport ----------------------------------

    def _tunnel_for(self, host):
        return self.transport.tunnel_for(host)

    def add_peer(self, label, ssh):
        """Own the ssh tunnel to a peer and link it. Replaces any tunnel
        or link already serving the same label or host."""

        def link_state(link_host):
            with self._lock:
                existing = self._peers.get(link_host)
                owns_link = self.transport.link_owned(link_host)
            return existing, owns_link

        def try_link(link_host, endpoint):
            return self.link_peer(
                link_host, endpoint, persist=False, replace=True)

        host, endpoint = self.transport.add(
            label, ssh, on_exit=self._tunnel_down,
            link_state=link_state, try_link=try_link)
        return {"label": label or ssh, "host": host, "endpoint": endpoint}

    def remove_peer(self, label, reap=True):
        """Close a peer's tunnel and drop its link. An explicit removal
        reaps its remote-parented forks at once instead of waiting out the
        reconnect grace."""
        host = self.transport.remove(label)
        if host:
            self._remove_peer(host, reap=reap)
        else:
            self._persist_peers()

    def _tunnel_down(self, tunnel):
        # ssh exited on its own. Forget the tunnel but keep the durable
        # config so the next broker start can restore it; drop the link
        # only when this tunnel still owned it.
        host = self.transport.forget_tunnel(tunnel)
        if host:
            self._remove_peer(host)

    def peer_list(self):
        def connected(link_host):
            with self._lock:
                peer = self._peers.get(link_host)
            return bool(peer and peer.connected)
        return self.transport.list(connected)


    def _peer_message(self, peer, msg):
        op = msg.get("op")
        if op == "peer-registry":
            with self._lock:
                self._remote[peer.host] = msg.get("agents") or []
        elif op == "peer-relay":
            self._deliver_peer(peer, msg)
        elif op == "peer-ack":
            self._finish_peer_relay(peer, msg)
        elif op == "peer-control":
            self._apply_peer_control(peer, msg)

    def _apply_peer_control(self, peer, msg):
        # A broker-level action from a peer, never addressed through an
        # agent: act only on our own agents, then ack.
        ok = False
        if msg.get("action") == "terminate":
            target = msg.get("to")
            if self._parent_host(target) == self.host:
                self._terminate(target, msg.get("why") or "requested")
                ok = True
        peer.send({"op": "peer-ack", "id": msg.get("id"), "ok": ok})

    def _deliver_peer(self, peer, msg):
        target = msg.get("to")
        with self._lock:
            conn = self._clients.get(target)
        if conn is not None:
            self._write(conn, self._envelope(
                msg.get("from") or peer.host,
                msg.get("kind"), msg.get("payload"),
                to=target, ts=msg.get("ts"),
            ))
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
        def try_restore(label, ssh):
            self.add_peer(label, ssh)

        self.transport.load(self.root.read_peers, try_restore)

    def _persist_peers(self):
        self.root.write_peers(self.transport.snapshot_config())

    # -- low-level writes -------------------------------------------

    def _reply(self, conn, **fields):
        self._write(conn, fields)

    def _write(self, conn, obj):
        try:
            conn.sendall(
                (json.dumps(obj, separators=(",", ":")) + "\n").encode()
            )
            return True
        except OSError:
            return False

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
            self._finish_queries.clear()
            self._peer_pending.clear()
            self._remote.clear()
            self._peer_down_at.clear()
            self._peers.clear()
            self._peers_by_conn.clear()
        self._close_tunnels()
        for entry in pending:
            self._reply(entry[0], op="error", error="undeliverable")
        self._close_tunnels()
        for conn in conns:
            try:
                conn.close()
            except OSError:
                pass
        for peer in peers:
            peer.drop()

    def _close_tunnels(self):
        self.transport.close_all()