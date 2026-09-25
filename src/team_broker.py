"""Registry + relay for connected agents on one loopback endpoint.

An agent registers once, then exchanges JSON-lines messages; the
broker relays to online recipients, mirrors the registry, and enforces
lifetime through connections only (liveness is connection liveness: a
closed connection ends its agent, and one idle past the single GC
window is asked to reap itself). One pid-probing exception: the broker
lock (see TeamRoot.acquire_lock).
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

from gc_reaper import GcReaper
from peer_link import PeerLink
from send_gate import SendGate
from peer_transport import PeerTransport
from wire import LineStream, dump_line
from peer_tunnel import PeerTunnel, PeerUnreachable
from settings import PackageSettings
from team_root import (
    ENDPOINT_NAME,
    REGISTRY_NAME,
    TeamRoot,
)


class TeamBroker:
    """Registry + relay for connected agents on one loopback endpoint."""

    def __init__(self, root=None, idle_timeout=15.0, sweep_interval=1.0,
                 gc_idle=None, busy_grace=None, sessions_root=None,
                 session_grace=None, restart_grace=None, peer_grace=None,
                 host=None, settings=None, tunnel_factory=None):
        # Settings own every configurable flag; an injected value (the
        # tests) or an explicit environment variable beats them.
        self.settings = settings or PackageSettings()
        self.root = TeamRoot(root or self.settings.state_dir())
        self.idle_timeout = idle_timeout
        self.sweep_interval = sweep_interval
        # Globally unique ids need a per-host label; peers route by the
        # host prefix of a target id.
        self.host = host or self.settings.host()
        # The single idle window: a session with no work contact this
        # long is asked to reap itself (see gc_reaper). Zero disables
        # the request.
        self.gc_idle = float(
            gc_idle if gc_idle is not None
            else self.settings.gc_idle()
        )
        # A .busy file whose agent is unregistered and whose mtime is
        # past this grace belongs to an old session (reload, crash, or
        # reaped fork); registered agents keep theirs however old.
        self.busy_grace = float(
            busy_grace if busy_grace is not None
            else self.settings.busy_grace()
        )
        # A teammate-marked pi session file whose agent is not live
        # and idle past this grace is swept (see gc_reaper); keeps old
        # forks out of pi's /resume list.
        self.sessions_root = pathlib.Path(
            sessions_root or self.settings.sessions_root()
        )
        self.session_grace = float(
            session_grace if session_grace is not None
            else self.settings.session_grace()
        )
        self.session_sweep_interval = float(
            self.settings.session_sweep_interval())
        self.token = secrets.token_hex(16)
        # Stamp the running source (the installed file's hash) so a
        # reloading extension can restart an older broker.
        self.version = self._source_version()
        # Restart policy: after the on-disk source changes, the broker
        # exits once idle this long, so the replacement adopts the new
        # code without killing live work.
        self.restart_grace = float(
            restart_grace if restart_grace is not None
            else self.settings.restart_grace()
        )
        # A dropped peer link (ssh flap, tunnel replacement) gets this
        # long to reconnect before its remote-parented forks are
        # reaped, so a brief partition does not kill live forks.
        self.peer_grace = float(
            peer_grace if peer_grace is not None
            else self.settings.peer_grace()
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
        # SSH transport (PeerTransport collaborator; the injected
        # factory keeps ssh out of unit tests).
        self.transport = PeerTransport(
            self.host, tunnel_factory=tunnel_factory)
        self.transport.persist = self._persist_peers
        # Store-and-forward owner: messages for a target whose hold is
        # restarting are parked on disk, replayed on re-register.
        self.delivery = MailboxDelivery(Mailbox(self.root))
        # The registry's derived views (online snapshot, mirror).
        self.mirror = RegistryMirror(
            self.root, self._registry, self.idle_timeout)
        self._lock = threading.RLock()
        self.gc = GcReaper(
            self.root, self._registry, self._lock,
            self.sessions_root, self.session_grace, self.busy_grace,
            self.gc_idle, self.session_sweep_interval,
            self._request_reap)
        self._running = False
        self._server = None

    def _source_version(self):
        # Hash every package source file, not just this one: the
        # broker's liveness windows come from settings.py, and a change
        # there must trigger the same idle-restart adoption as a change
        # to this module.
        digest = hashlib.sha256()
        try:
            for path in sorted(pathlib.Path(__file__).parent.glob("*.py")):
                with open(path, "rb") as fh:
                    digest.update(fh.read())
        except OSError:
            return ""
        return digest.hexdigest()[:16]

    # -- broker lock -------------------------------------------------

    def _remove_endpoint(self):
        # Only remove the endpoint this broker published; a newer one
        # may have replaced it while we were stopping.
        try:
            if self.root.read_endpoint().get("token") == self.token:
                self.root.endpoint.unlink()
        except OSError:
            pass

    # -- lifecycle ---------------------------------------------------

    def run(self):
        self.root.ensure()
        if not self.root.acquire_lock():
            # Another broker owns this root; wait briefly for its
            # endpoint, then leave it to serve.
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
            self.root.release_pid()
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
            # A timeout lets the loop notice stop() promptly (closing a
            # listening socket does not reliably wake a blocked accept()).
            server.listen(16)
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
            self.root.write_pid()
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
        # the serve loop's finally may lag; dropping now sends the peer
        # an EOF and drives connection-based GC.
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
        # Adopt newly installed code only once idle: a self-exit drops
        # every hold, so never while agents are working.
        if self._should_restart(now):
            self.stop()

    def _should_restart(self, now):
        # Pure policy: the on-disk source changed and the broker has
        # been idle past the grace.
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
        stream = LineStream()
        while self._running:
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                return
            if not chunk:
                return
            stream.push(chunk)
            while True:
                line = stream.next_line()
                if line is None:
                    break
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
            # The shim's keepalive; a busy ping marks active work and
            # holds the fork idle clock, a waiting ping is blocked in
            # a wait (not idle, not working).
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
        elif op == "gc-reap":
            # A session's own agent answered the reaper's request by
            # calling its reap tool: drop its registration and files
            # (a teammate transcript included), then ack. The tool owns
            # the orderly process shutdown.
            target = str(msg.get("id") or agent_id or "")
            if not self._send_gate.check(target, msg.get("send_token")):
                self._reply(conn, op="error", error="send-token",
                            detail=SendGate.refused_reason())
            else:
                self._drop_entry(target)
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
        stale = []
        with self._lock:
            for old_id in self._stale_same_owner(agent_id, entry):
                stale.append((old_id, self._release(old_id, dropped=True)[0]))
            self._clients[agent_id] = conn
            self._registry[agent_id] = entry
            self._send_gate.issue(agent_id, msg.get("send_token"))
        for old_id, old_entry in stale:
            self.root.remove_busy_file(old_entry)
            self.gc.remove_session_file(old_entry)
        self._persist_and_notify()
        self._reply(conn, op="ack", id=agent_id)
        self.delivery.replay(
            agent_id, lambda envelope: self._write(conn, envelope))
        return agent_id

    def _stale_same_owner(self, agent_id, entry):
        # One registration per live session: a hold restart or reload
        # re-registering under a fresh id with the same owner pid and
        # session file replaces the stale entry. Only a same-session
        # duplicate qualifies, so a pid reused by an unrelated session
        # never collides; the registering connection wins, and the
        # reloaded-away instance stops re-registering because its
        # replacement handed its identity over.
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
        if work and agent_id:
            # Fresh work ends the idle episode: the reaper may ask
            # again only after a new idle window.
            self.gc.forget_request(agent_id)
        if due:
            self.root.write_atomic(REGISTRY_NAME, data + "\n")

    def _release(self, agent_id, dropped=False):
        """The one registration release path, for every drop: removes
        the entry, its connection, its gate credential, and any
        outstanding reap request. `dropped` records a connection loss
        (not an eviction), so sends during the hold-restart gap park.
        Returns (entry, conn) for the caller's GC and teardown."""
        with self._lock:
            entry = self._registry.pop(agent_id, None)
            conn = self._clients.pop(agent_id, None)
            self._send_gate.drop(agent_id)
            if dropped and entry is not None:
                self.delivery.mark_dropped(agent_id)
        self.gc.forget_request(agent_id)
        return entry, conn

    def _drop_entry(self, agent_id):
        entry, _ = self._release(agent_id)
        self.root.remove_busy_file(entry)
        self.gc.remove_session_file(entry)
        self._persist_and_notify()

    def _drop_conn(self, agent_id):
        if not agent_id:
            return
        entry, _ = self._release(agent_id, dropped=True)
        if entry is not None:
            self.root.remove_busy_file(entry)
            self._persist_and_notify()

    # -- messaging ---------------------------------------------------

    def _envelope(self, from_id, kind, payload, to=None, ts=None):
        # The wire envelope every delivered message wears; the id lets
        # a client filter redeliveries (mailbox drain after a crash
        # between delivery and unlink) from fresh traffic.
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
        # Drop the endpoint and entry, tell the connection why, signal
        # the fork process. The caller persists: terminate does, a
        # sweep once per batch.
        entry, conn = self._release(agent_id)
        if conn is not None:
            self._write(conn, self._envelope(
                "*", "terminate", {"id": agent_id, "why": why}))
            try:
                conn.close()
            except OSError:
                pass
        self.root.remove_busy_file(entry)
        self.gc.remove_session_file(entry)
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
        # GC enforcement: a teammate's termination must reach the pi
        # process, not just its endpoint shim. Only forks carry an
        # owner pid; SIGTERM (TerminateProcess on Windows).
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

    def _sweep_loop(self):
        while self._running:
            time.sleep(self.sweep_interval)
            self._sweep()

    def _sweep(self):
        # One bad stage must never kill the sweep thread: a raised
        # OSError (a full or read-only state dir) would otherwise stop
        # the reap request, mailbox prune, peer expiry, and restart
        # policy for the daemon's whole life.
        try:
            self._sweep_once()
        except Exception as exc:
            log("sweep failed: %s" % exc)

    def _sweep_once(self):
        now = time.time()
        self._expire_peer_relays()
        self._reap_expired_peers(now)
        self.gc.gc_orphan_busy_files(now)
        self.gc.gc_orphan_session_files(now)
        self.gc.gc_tmp_files(now)
        self.delivery.prune(now)
        self._maybe_restart(now)
        self.gc.request_idle_reaps(now)

    def _request_reap(self, agent_id, why):
        # Sends the reap request to a reachable session: its own agent
        # answers by calling team_gc_reap. A dropped connection returns
        # False so the reaper retries on the next sweep.
        conn = self._clients.get(agent_id)
        if conn is None:
            return False
        return self._write(conn, self._envelope(
            "*", "gc-reap",
            {"id": agent_id, "why": why,
             "hours": round(self.gc_idle / 3600.0, 3)}))

    # -- peer federation ---------------------------------------------

    def _parent_host(self, agent_id):
        # The host prefix on an agent id, or our host for a bare local
        # one; routing and cross-host parentage both use this.
        if isinstance(agent_id, str) and ":" in agent_id:
            return agent_id.split(":", 1)[0]
        return self.host

    def _snapshot_all(self):
        agents = self._snapshot()
        with self._lock:
            remote = list(self._remote.items())
        for host, entries in remote:
            for entry in entries:
                # The peer's registry is the liveness signal for its
                # agents; forcing online=False would hide live remote
                # agents from ls.
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
        # Our outbound tunnel to this host is now redundant (ownership
        # already cleared, so _tunnel_down keeps the inbound link);
        # close it, keeping the durable config - the label stays a
        # known peer served by the inbound link.
        redundant = self._tunnel_for(host)
        if redundant is not None and self.host > host:
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
            # open() closed its own socket; this link never went live,
            # so it must not reach _peer_down (which would mark the
            # host down and start the fork-reap grace). A failed
            # replacement leaves any working link in place.
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
        # A replaced link must not reap live forks: only the current
        # link owns its host's remote view and reaping. Pending relays
        # are keyed by identity, purged for every dropped link.
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
        # A dropped peer link defers reaping for the reconnect grace;
        # a host that never returns has its remote-parented forks
        # reaped here once the grace passes.
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
        # A silent peer must not leak its pending relay or hang the
        # sender: answer undeliverable after the idle window.
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
        # A dropped peer link owns its remote-parented forks: they
        # cannot outlive the host that spawned them. Only a link loss
        # reaches here; a local parent's own disconnect does not reap
        # its forks (the single idle window does).
        doomed = []
        with self._lock:
            for agent_id, entry in list(self._registry.items()):
                if entry.get("role") != "fork":
                    continue
                if self._parent_host(entry.get("parent")) == host:
                    doomed.append(agent_id)
        for agent_id in doomed:
            self._evict(agent_id, "peer-down")
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
            conn.sendall(dump_line(obj))
            return True
        except OSError:
            return False

    def _close_all(self):
        # Shutdown leaves nothing reachable behind: clear every map
        # (clients, entries, peers, remote views, pending relays);
        # pending senders are answered before their connections close
        # so a shutdown never strands a request.
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
        self._close_tunnels()
        for entry in pending:
            self._reply(entry[0], op="error", error="undeliverable")
        for conn in conns:
            try:
                conn.close()
            except OSError:
                pass
        for peer in peers:
            peer.drop()

    def _close_tunnels(self):
        self.transport.close_all()