"""Broker protocol tests: handshake, registry, relay, liveness."""

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import unittest

from harness import make_root, read_endpoint, wait_endpoint, wait_until
from peer_tunnel import PeerTunnel, PeerUnreachable
from team import TeamClient
from teamd import TEAMMATE_MARKER, PeerLink, TeamBroker

IDLE_ROOMY = 30.0


class FakeTunnel:
    """A PeerTunnel stand-in that links to a real peer endpoint."""

    def __init__(self, label, ssh, endpoint, on_exit=None):
        self.label = label
        self.ssh = ssh
        self.host = endpoint.get("name") or label
        self.closed = False
        self.started = False
        self._endpoint = endpoint
        self._on_exit = on_exit

    def start(self):
        self.started = True
        return {"host": self._endpoint["host"],
                "port": self._endpoint["port"],
                "token": self._endpoint["token"], "name": self.host}

    def close(self):
        self.closed = True

    def setup_command(self):
        return "sh setup '%s'" % self.ssh

    def flap(self):
        # Simulate ssh exiting on its own; the broker's on_exit fires.
        if self._on_exit is not None:
            self._on_exit(self)


class RecordingTunnelFactory:
    """Builds FakeTunnels pointed at one peer root, recording them."""

    def __init__(self, peer_root):
        self.peer_root = peer_root
        self.tunnels = []

    def __call__(self, label, ssh, on_exit=None):
        endpoint = read_endpoint(self.peer_root)
        tunnel = FakeTunnel(label, ssh, endpoint, on_exit)
        self.tunnels.append(tunnel)
        return tunnel


class PeerTunnelTests(unittest.TestCase):
    def test_classifies_common_ssh_failures(self):
        tunnel = PeerTunnel("l", "user@host")
        self.assertIn("host key",
                      tunnel._classify("Host key verification failed."))
        self.assertIn("password",
                      tunnel._classify("Permission denied (publickey)."))
        self.assertEqual(tunnel._classify("  boom  \nsecond"), "boom")
        self.assertEqual(tunnel._classify(""), "")

    def test_setup_command_is_quoted_for_a_shell(self):
        tunnel = PeerTunnel("l", "user@host")
        command = tunnel.setup_command()
        self.assertTrue(command.startswith("sh "))
        self.assertIn("'user@host'", command)

    def test_reserve_port_returns_a_free_loopback_port(self):
        tunnel = PeerTunnel("l", "user@host")
        port = tunnel._reserve_port()
        self.assertGreater(port, 0)

    def test_missing_ssh_is_unreachable(self):
        tunnel = PeerTunnel("l", "user@host", which=lambda _name: None)
        with self.assertRaises(PeerUnreachable) as caught:
            tunnel.start()
        self.assertIn("ssh is not installed", caught.exception.detail)


class BrokerProtocolTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.sessions_root = os.path.join(self.root, "sessions")
        os.makedirs(self.sessions_root, exist_ok=True)
        self.broker = TeamBroker(self.root, idle_timeout=IDLE_ROOMY,
                                 sweep_interval=0.2, busy_grace=0.3,
                                 sessions_root=self.sessions_root,
                                 session_grace=0.3)
        self.broker._session_sweep_interval = 0.2
        self.thread = threading.Thread(target=self.broker.run, daemon=True)
        self.thread.start()
        wait_endpoint(self.root)
        self.checker = TeamClient(self.root)
        self.checker.id = "checker"
        self.checker.register()

    def tearDown(self):
        self.checker.close()
        self.broker.stop()
        self.thread.join(timeout=3)
        shutil.rmtree(self.root, ignore_errors=True)

    def _agents(self):
        reply = self.checker.ls()
        return {a["id"]: a for a in reply["agents"]}

    def _agent(self, agent_id, role="cli", parent=None):
        client = TeamClient(self.root)
        client.id = agent_id
        client.name = agent_id
        client.role = role
        client.parent = parent
        reply = client.register()
        self.assertIn(reply.get("op"), ("ack", "error"), reply)
        return client

    def _busy_agent(self, agent_id, busy_path):
        client = TeamClient(self.root)
        client.id = agent_id
        client.name = agent_id
        client.busy_file = busy_path
        with open(busy_path, "w") as fh:
            fh.write("1")
        reply = client.register()
        self.assertIn(reply.get("op"), ("ack", "error"), reply)
        return client

    def _write_session(self, path, marker=True):
        with open(path, "w") as fh:
            fh.write(json.dumps({"type": "session", "id": path,
                                 "cwd": self.root}) + "\n")
            if marker:
                fh.write(json.dumps({"type": "message", "role": "user",
                                     "content": TEAMMATE_MARKER}) + "\n")

    def test_fork_session_removed_on_deregister(self):
        path = os.path.join(self.sessions_root, "fork-a.jsonl")
        self._write_session(path, marker=True)
        client = TeamClient(self.root)
        client.id = "beta:fork-a"
        client.role = "fork"
        client.parent = "checker"
        client.session = path
        client.register()
        client.deregister()
        self.assertFalse(os.path.exists(path))

    def test_main_session_file_is_not_removed(self):
        path = os.path.join(self.sessions_root, "main-a.jsonl")
        self._write_session(path, marker=True)
        client = TeamClient(self.root)
        client.id = "alpha:main-a"
        client.role = "main"
        client.session = path
        client.register()
        client.deregister()
        self.assertTrue(os.path.exists(path),
                        "a main agent's session file must never be removed")

    def test_attached_session_file_survives_deregister(self):
        # An attached fork carries no spawn marker: it is the user's own
        # transcript and must stay in /resume after the fork is reaped.
        path = os.path.join(self.sessions_root, "attached.jsonl")
        self._write_session(path, marker=False)
        client = TeamClient(self.root)
        client.id = "beta:attached"
        client.role = "fork"
        client.parent = "alpha:caller"
        client.session = path
        client.register()
        client.deregister()
        self.assertTrue(os.path.exists(path),
                        "an attached session's transcript must not be removed")

    def test_orphan_teammate_session_is_swept(self):
        path = os.path.join(self.sessions_root, "orphan.jsonl")
        self._write_session(path, marker=True)
        old = time.time() - 3600
        os.utime(path, (old, old))
        self.assertTrue(
            wait_until(lambda: not os.path.exists(path)),
            "old teammate session file was not swept",
        )

    def test_non_teammate_session_is_kept(self):
        path = os.path.join(self.sessions_root, "plain.jsonl")
        self._write_session(path, marker=False)
        old = time.time() - 3600
        os.utime(path, (old, old))
        time.sleep(0.6)
        self.assertTrue(os.path.exists(path),
                        "a non-teammate session file must not be swept")

    def test_live_fork_session_survives_sweep(self):
        path = os.path.join(self.sessions_root, "live-fork.jsonl")
        self._write_session(path, marker=True)
        client = TeamClient(self.root)
        client.id = "beta:live-fork"
        client.role = "fork"
        client.parent = "checker"
        client.session = path
        client.register()
        old = time.time() - 3600
        os.utime(path, (old, old))
        time.sleep(0.6)
        self.assertTrue(os.path.exists(path),
                        "a live fork's session file must not be swept")
        client.deregister()

    def test_deregister_removes_busy_file(self):
        path = os.path.join(self.root, "busy-a.busy")
        client = self._busy_agent("busy-a", path)
        self.assertTrue(os.path.exists(path))
        client.deregister()
        self.assertFalse(os.path.exists(path))

    def test_orphan_busy_file_is_swept(self):
        path = os.path.join(self.root, "orphan.busy")
        with open(path, "w") as fh:
            fh.write("0")
        old = time.time() - 3600
        os.utime(path, (old, old))
        self.assertTrue(
            wait_until(lambda: not os.path.exists(path)),
            "old orphan busy file was not swept",
        )

    def test_registered_busy_file_survives_sweep(self):
        path = os.path.join(self.root, "live.busy")
        client = self._busy_agent("live", path)
        old = time.time() - 3600
        os.utime(path, (old, old))
        time.sleep(0.6)
        self.assertTrue(
            os.path.exists(path),
            "a registered agent's busy file must not be swept",
        )
        client.deregister()

    def test_handshake_rejects_bad_token(self):
        endpoint = self.broker.root.read_endpoint()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        sock.connect((endpoint["host"], endpoint["port"]))
        sock.sendall(
            (json.dumps({"op": "hello", "token": "wrong"}) + "\n").encode()
        )
        reply = sock.recv(4096)
        sock.close()
        self.assertIn(b'"error":"bad-handshake"', reply)

    def test_broker_publishes_endpoint(self):
        endpoint = self.broker.root.read_endpoint()
        self.assertEqual(endpoint["host"], "127.0.0.1")
        self.assertTrue(endpoint["port"] > 0)
        self.assertTrue(len(endpoint["token"]) >= 32)
        self.assertTrue(endpoint.get("version"),
                        "the endpoint must carry a source stamp")

    def test_restart_policy_uses_the_idle_window(self):
        broker = TeamBroker(self.root, restart_grace=10)
        now = time.time()
        broker.last_active = now
        broker.version = "older-source"
        self.assertFalse(broker._should_restart(now),
                         "recent activity must not restart")
        self.assertTrue(broker._should_restart(now + 11),
                        "an idle stale broker must restart")
        broker.version = broker._source_version()
        self.assertFalse(broker._should_restart(now + 11),
                         "a matching source must not restart")

    def test_register_and_discover(self):
        self._agent("alpha", role="main")
        agents = self._agents()
        self.assertIn("alpha", agents)
        self.assertIn("checker", agents)
        self.assertEqual(agents["alpha"]["role"], "main")
        self.assertEqual(agents["alpha"]["name"], "alpha")

    def test_send_relay(self):
        alpha = self._agent("alpha")
        beta = self._agent("beta")
        received = []
        ready = threading.Event()
        thread = threading.Thread(
            target=beta.follow,
            args=(received.append, ready.set),
            daemon=True,
        )
        thread.start()
        self.assertTrue(
            ready.wait(timeout=3),
            "follower never finished its registration",
        )
        reply = alpha.send_msg("beta", "text", {"ping": 1})
        self.assertEqual(reply.get("op"), "ack", reply)
        self.assertTrue(
            wait_until(lambda: received),
            "beta never received the relayed message",
        )
        msg = received[0]
        self.assertEqual(msg["op"], "message")
        self.assertEqual(msg["from"], "alpha")
        self.assertEqual(msg["to"], "beta")
        self.assertEqual(msg["kind"], "text")
        self.assertEqual(msg["payload"], {"ping": 1})
        beta.close()
        alpha.close()
        thread.join(timeout=3)

    def test_undeliverable(self):
        alpha = self._agent("alpha")
        reply = alpha.send_msg("ghost", "text", "hello")
        self.assertEqual(reply.get("op"), "error")
        self.assertEqual(reply.get("error"), "undeliverable")
        alpha.close()

    def test_unregistered_sender_gets_ack(self):
        beta = self._agent("beta")
        alpha = TeamClient(self.root)
        alpha.id = "alpha"
        reply = alpha.send_msg("beta", "text", "hi")
        self.assertEqual(reply.get("op"), "ack", reply)
        alpha.close()
        beta.close()

    def test_deregister(self):
        alpha = self._agent("alpha")
        beta = self._agent("beta")
        beta.deregister()
        agents = self._agents()
        self.assertIn("alpha", agents)
        self.assertNotIn("beta", agents)
        alpha.close()

    def test_connection_close_drops_agent(self):
        alpha = self._agent("alpha")
        self.assertIn("alpha", self._agents())
        alpha.close()
        self.assertTrue(
            wait_until(lambda: "alpha" not in self._agents()),
            "closed connection was not swept",
        )

    def test_idle_sweep(self):
        root = make_root()
        broker = TeamBroker(root, idle_timeout=0.4, sweep_interval=0.1)
        thread = threading.Thread(target=broker.run, daemon=True)
        thread.start()
        try:
            wait_endpoint(root)
            ghost = TeamClient(root, heartbeat=None)
            ghost.id = "ghost"
            ghost.register()
            self.assertTrue(
                wait_until(lambda: "ghost" not in self._ids_via(root)),
                "idle agent was never swept",
            )
        finally:
            broker.stop()
            thread.join(timeout=3)
            shutil.rmtree(root, ignore_errors=True)

    def test_broker_lock_single_instance(self):
        root = make_root()
        first = TeamBroker(root, idle_timeout=IDLE_ROOMY, sweep_interval=0.2)
        thread = threading.Thread(target=first.run, daemon=True)
        thread.start()
        ep = wait_endpoint(root)
        loser_done = []
        second = TeamBroker(root)
        loser = threading.Thread(
            target=lambda: loser_done.append(second.run()), daemon=True
        )
        loser.start()
        loser.join(timeout=3)
        self.assertTrue(loser_done,
                        "losing broker must return without binding")
        self.assertIsNone(second._server,
                         "losing broker must not bind a socket")
        published = TeamBroker(root).root.read_endpoint()
        self.assertEqual(ep["port"], published["port"],
                         "endpoint must still point at the winner")
        first.stop()
        thread.join(timeout=3)
        shutil.rmtree(root, ignore_errors=True)

    def test_idle_fork_is_asked_before_reap_and_spared(self):
        # The courtesy query: an idle fork is asked whether it is done
        # and survives while its answer window is open.
        root = make_root()
        broker = TeamBroker(root, idle_timeout=IDLE_ROOMY, fork_idle=0.3,
                            sweep_interval=0.1, gc_ping_grace=1.5)
        thread = threading.Thread(target=broker.run, daemon=True)
        thread.start()
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"]
        )
        try:
            wait_endpoint(root)
            parent = TeamClient(root, heartbeat=None)
            parent.id = "parent-q"
            parent.role = "main"
            parent.register()
            fork = TeamClient(root, heartbeat=None)
            fork.id = "fork-query"
            fork.name = "fork-query"
            fork.role = "fork"
            fork.parent = "parent-q"
            fork.owner_pid = str(dummy.pid)
            fork.register()
            # Past the fork-idle window the query is sent and the fork
            # stays registered well past the fork-idle grace.
            self.assertTrue(
                wait_until(
                    lambda: "fork-query" in broker._finish_queries.ids(),
                    timeout=3),
                "idle fork was never asked whether it is done",
            )
            time.sleep(1.0)
            self.assertIn("fork-query", self._ids_via(root),
                          "queried fork was reaped inside its grace")
            self.assertIsNone(dummy.poll(),
                              "queried fork's owner was signalled early")
            # Silence past the grace proceeds to the reap.
            self.assertTrue(
                wait_until(lambda: dummy.poll() is not None, timeout=8),
                "idle fork's owner was never garbage-collected",
            )
            self.assertTrue(
                wait_until(lambda: "fork-query" not in self._ids_via(root)),
                "garbage-collected fork stays in the registry",
            )
        finally:
            broker.stop()
            thread.join(timeout=3)
            try:
                dummy.kill()
            except OSError:
                pass
            dummy.wait(timeout=5)
            shutil.rmtree(root, ignore_errors=True)

    def test_finish_yes_resets_the_idle_clock(self):
        root = make_root()
        broker = TeamBroker(root, idle_timeout=IDLE_ROOMY, fork_idle=0.3,
                            sweep_interval=0.1, gc_ping_grace=1.0)
        thread = threading.Thread(target=broker.run, daemon=True)
        thread.start()
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"]
        )
        try:
            wait_endpoint(root)
            parent = TeamClient(root, heartbeat=None)
            parent.id = "parent-y2"
            parent.role = "main"
            parent.register()
            fork = TeamClient(root, heartbeat=None)
            fork.id = "fork-yes"
            fork.role = "fork"
            fork.parent = "parent-y2"
            fork.owner_pid = str(dummy.pid)
            fork.register()
            self.assertTrue(
                wait_until(lambda: "fork-yes" in self._ids_via(root)),
            )
            time.sleep(0.6)
            # The agent answers that it is still working: the query
            # closes and the fork gets a fresh idle window.
            fork.send_msg("*", "finish-yes", {"id": "fork-yes"})
            time.sleep(0.3)
            self.assertIn("fork-yes", self._ids_via(root),
                          "finish-yes did not spare the fork")
            self.assertIsNone(dummy.poll(),
                              "finish-yes still led to a signal")
        finally:
            broker.stop()
            thread.join(timeout=3)
            try:
                dummy.kill()
            except OSError:
                pass
            dummy.wait(timeout=5)
            shutil.rmtree(root, ignore_errors=True)

    def test_finish_no_reaps_at_once(self):
        root = make_root()
        broker = TeamBroker(root, idle_timeout=IDLE_ROOMY, fork_idle=0.3,
                            sweep_interval=0.1, gc_ping_grace=5.0)
        thread = threading.Thread(target=broker.run, daemon=True)
        thread.start()
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"]
        )
        try:
            wait_endpoint(root)
            parent = TeamClient(root, heartbeat=None)
            parent.id = "parent-n"
            parent.role = "main"
            parent.register()
            fork = TeamClient(root, heartbeat=None)
            fork.id = "fork-no"
            fork.role = "fork"
            fork.parent = "parent-n"
            fork.owner_pid = str(dummy.pid)
            fork.register()
            time.sleep(0.5)
            # The agent answers that it is done: no grace is awaited.
            fork.send_msg("*", "finish-no", {"id": "fork-no"})
            self.assertTrue(
                wait_until(lambda: dummy.poll() is not None, timeout=5),
                "finish-no did not reap the finished fork",
            )
            self.assertTrue(
                wait_until(lambda: "fork-no" not in self._ids_via(root)),
            )
        finally:
            broker.stop()
            thread.join(timeout=3)
            try:
                dummy.kill()
            except OSError:
                pass
            dummy.wait(timeout=5)
            shutil.rmtree(root, ignore_errors=True)

    def test_fork_idle_gc_kills_owner(self):
        root = make_root()
        broker = TeamBroker(root, idle_timeout=IDLE_ROOMY, fork_idle=0.3,
                            sweep_interval=0.1, gc_ping_grace=0)
        thread = threading.Thread(target=broker.run, daemon=True)
        thread.start()
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"]
        )
        try:
            wait_endpoint(root)
            parent = TeamClient(root, heartbeat=None)
            parent.id = "parent-x"
            parent.role = "main"
            parent.register()
            fork = TeamClient(root, heartbeat=None)
            fork.id = "fork-gc"
            fork.name = "fork-gc"
            fork.role = "fork"
            fork.parent = "parent-x"
            fork.owner_pid = str(dummy.pid)
            self.assertIn(fork.register().get("op"), ("ack", "error"))
            self.assertTrue(
                wait_until(lambda: dummy.poll() is not None, timeout=6),
                "idle fork's owner was never garbage-collected",
            )
            self.assertTrue(
                wait_until(lambda: "fork-gc" not in self._ids_via(root)),
                "garbage-collected fork stays in the registry",
            )
        finally:
            broker.stop()
            thread.join(timeout=3)
            try:
                dummy.kill()
            except OSError:
                pass
            dummy.wait(timeout=5)
            shutil.rmtree(root, ignore_errors=True)

    def test_busy_ping_keeps_fork_alive(self):
        root = make_root()
        broker = TeamBroker(root, idle_timeout=IDLE_ROOMY, fork_idle=0.5,
                            sweep_interval=0.1, gc_ping_grace=0)
        thread = threading.Thread(target=broker.run, daemon=True)
        thread.start()
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"]
        )
        try:
            wait_endpoint(root)
            parent = TeamClient(root, heartbeat=None)
            parent.id = "parent-y"
            parent.role = "main"
            parent.register()
            fork = TeamClient(root, heartbeat=None)
            fork.id = "fork-busy"
            fork.role = "fork"
            fork.parent = "parent-y"
            fork.owner_pid = str(dummy.pid)
            fork.register()
            stop_pings = threading.Event()

            def ping_busy():
                while not stop_pings.is_set():
                    fork.send({"op": "ping", "busy": True})
                    time.sleep(0.2)

            pinger = threading.Thread(target=ping_busy, daemon=True)
            pinger.start()
            time.sleep(1.4)
            self.assertIsNone(dummy.poll(),
                              "busy fork was garbage-collected")
            self.assertIn("fork-busy", self._ids_via(root))
            stop_pings.set()
            self.assertTrue(
                wait_until(lambda: dummy.poll() is not None, timeout=6),
                "fork never GC'd after going idle",
            )
        finally:
            broker.stop()
            thread.join(timeout=3)
            try:
                dummy.kill()
            except OSError:
                pass
            dummy.wait(timeout=5)
            shutil.rmtree(root, ignore_errors=True)

    def test_waiting_fork_survives_idle_gc(self):
        root = make_root()
        broker = TeamBroker(root, idle_timeout=2.0, fork_idle=0.5,
                            sweep_interval=0.1, gc_ping_grace=0)
        thread = threading.Thread(target=broker.run, daemon=True)
        thread.start()
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"]
        )
        busy = os.path.join(root, "fork-wait.busy")
        with open(busy, "w") as fh:
            fh.write("2")
        try:
            wait_endpoint(root)
            parent = TeamClient(root, heartbeat=0.2)
            parent.id = "parent-w"
            parent.role = "main"
            parent.register()
            fork = TeamClient(root, heartbeat=0.2)
            fork.id = "fork-wait"
            fork.role = "fork"
            fork.parent = "parent-w"
            fork.owner_pid = str(dummy.pid)
            fork.busy_file = busy
            fork.register()
            # Waiting is not work, but it is not idle either: the fork
            # must outlive several fork-idle windows while it waits.
            time.sleep(2.0)
            self.assertIsNone(dummy.poll(),
                              "waiting fork was garbage-collected")
            self.assertIn("fork-wait", self._ids_via(root))
            # Leaving the wait lets the stale work clock expire it again.
            with open(busy, "w") as fh:
                fh.write("0")
            self.assertTrue(
                wait_until(lambda: dummy.poll() is not None, timeout=6),
                "fork never GC'd after it left the wait",
            )
        finally:
            broker.stop()
            thread.join(timeout=3)
            try:
                dummy.kill()
            except OSError:
                pass
            dummy.wait(timeout=5)
            shutil.rmtree(root, ignore_errors=True)

    def _start_broker(self, root, host, tunnel_factory=None):
        sessions = os.path.join(root, "sessions")
        os.makedirs(sessions, exist_ok=True)
        broker = TeamBroker(root, idle_timeout=IDLE_ROOMY,
                            sweep_interval=0.1, host=host,
                            peer_grace=0.3, sessions_root=sessions,
                            session_grace=0.3,
                            tunnel_factory=tunnel_factory)
        thread = threading.Thread(target=broker.run, daemon=True)
        thread.start()
        wait_endpoint(root)
        return broker, thread

    def test_peer_federation_relays_both_ways(self):
        root_a = make_root()
        root_b = make_root()
        broker_a, thread_a = self._start_broker(root_a, "alpha")
        broker_b, thread_b = self._start_broker(root_b, "beta")
        try:
            beta_rx = TeamClient(root_b, heartbeat=None)
            beta_rx.id = "beta:main"
            beta_rx.role = "main"
            beta_rx.register()
            alpha_caller = TeamClient(root_a, heartbeat=None)
            alpha_caller.id = "alpha:caller"
            alpha_caller.register()
            beta_tx = TeamClient(root_b, heartbeat=None)
            beta_tx.id = "beta:sender"
            beta_tx.register()
            alpha_tx = TeamClient(root_a, heartbeat=None)
            alpha_tx.id = "alpha:tx"
            alpha_tx.register()

            endpoint_b = broker_b.root.read_endpoint()
            self.assertTrue(broker_a.link_peer("beta", endpoint_b))
            self.assertTrue(
                wait_until(lambda: "alpha" in broker_b._peers),
                "peer link was never accepted")
            # The federated view exposes the peer's agent.
            self.assertTrue(wait_until(
                lambda: any(a["id"] == "beta:main"
                            for a in alpha_caller.ls()["agents"])))

            # alpha -> beta
            beta_inbox = []
            ready = threading.Event()
            tb = threading.Thread(
                target=beta_rx.follow, args=(beta_inbox.append, ready.set),
                daemon=True)
            tb.start()
            self.assertTrue(ready.wait(timeout=3))
            self.assertEqual(
                alpha_caller.send_msg("beta:main", "text", "hi-beta").get("op"),
                "ack")
            self.assertTrue(wait_until(lambda: beta_inbox))
            self.assertEqual(beta_inbox[0]["from"], "alpha:caller")

            # beta -> alpha
            alpha_inbox = []
            ready2 = threading.Event()
            ta = threading.Thread(
                target=alpha_caller.follow, args=(alpha_inbox.append,
                                                  ready2.set), daemon=True)
            ta.start()
            self.assertTrue(ready2.wait(timeout=3))
            self.assertEqual(
                beta_tx.send_msg("alpha:caller", "text", "hi-alpha").get("op"),
                "ack")
            self.assertTrue(wait_until(lambda: alpha_inbox))
            self.assertEqual(alpha_inbox[0]["from"], "beta:sender")

            # An unknown remote target is undeliverable, not lost.
            reply = alpha_tx.send_msg("beta:ghost", "text", "x")
            self.assertEqual(reply.get("op"), "error")
            self.assertEqual(reply.get("error"), "undeliverable")
        finally:
            broker_a.stop()
            broker_b.stop()
            thread_a.join(timeout=3)
            thread_b.join(timeout=3)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def test_peer_down_reaps_remote_parent_forks(self):
        root_a = make_root()
        root_b = make_root()
        broker_a, thread_a = self._start_broker(root_a, "alpha")
        broker_b, thread_b = self._start_broker(root_b, "beta")
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        try:
            caller = TeamClient(root_a, heartbeat=0.2)
            caller.id = "alpha:caller"
            caller.role = "main"
            caller.register()
            endpoint_b = broker_b.root.read_endpoint()
            broker_a.link_peer("beta", endpoint_b)
            self.assertTrue(wait_until(lambda: "alpha" in broker_b._peers))
            self.assertTrue(wait_until(lambda: any(
                a.get("id") == "alpha:caller"
                for a in broker_b._remote.get("alpha", []))))
            fork = TeamClient(root_b, heartbeat=None)
            fork.id = "beta:fork-remote"
            fork.role = "fork"
            fork.parent = "alpha:caller"
            fork.owner_pid = str(dummy.pid)
            fork.register()
            time.sleep(1.0)
            self.assertIsNone(dummy.poll(),
                              "remote-parent fork reaped while peer is up")
            broker_a.stop()
            thread_a.join(timeout=3)
            self.assertTrue(
                wait_until(lambda: dummy.poll() is not None, timeout=6),
                "remote fork not reaped when its peer went down")
            self.assertTrue(wait_until(
                lambda: "beta:fork-remote" not in self._ids_via(root_b)),
                "reaped remote fork still in the registry")
        finally:
            broker_b.stop()
            thread_b.join(timeout=3)
            try:
                dummy.kill()
            except OSError:
                pass
            dummy.wait(timeout=5)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def test_peer_reconnect_within_grace_spares_forks(self):
        root_a = make_root()
        root_b = make_root()
        broker_a, thread_a = self._start_broker(root_a, "alpha")
        broker_b, thread_b = self._start_broker(root_b, "beta")
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        try:
            caller = TeamClient(root_a, heartbeat=0.2)
            caller.id = "alpha:caller"
            caller.role = "main"
            caller.register()
            endpoint_a = broker_a.root.read_endpoint()
            broker_a.link_peer("beta", broker_b.root.read_endpoint())
            self.assertTrue(wait_until(lambda: "alpha" in broker_b._peers))
            self.assertTrue(wait_until(lambda: any(
                a.get("id") == "alpha:caller"
                for a in broker_b._remote.get("alpha", []))))
            fork = TeamClient(root_b, heartbeat=None)
            fork.id = "beta:fork-flap"
            fork.role = "fork"
            fork.parent = "alpha:caller"
            fork.owner_pid = str(dummy.pid)
            fork.register()
            time.sleep(1.0)
            # Drop the live link, then restore it inside the grace: a
            # transient flap must not kill a fork whose parent is alive.
            broker_b._peer_down(broker_b._peers["alpha"])
            self.assertTrue(broker_b.link_peer("alpha", endpoint_a))
            time.sleep(1.0)
            self.assertIsNone(dummy.poll(),
                              "a reconnected peer reaped its live fork")
            self.assertIn("beta:fork-flap", self._ids_via(root_b))
        finally:
            broker_b.stop()
            thread_b.join(timeout=3)
            broker_a.stop()
            thread_a.join(timeout=3)
            try:
                dummy.kill()
            except OSError:
                pass
            dummy.wait(timeout=5)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def test_replaced_peer_does_not_reap_current_forks(self):
        root_a = make_root()
        root_b = make_root()
        broker_a, thread_a = self._start_broker(root_a, "alpha")
        broker_b, thread_b = self._start_broker(root_b, "beta")
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        try:
            caller = TeamClient(root_a, heartbeat=0.2)
            caller.id = "alpha:caller"
            caller.role = "main"
            caller.register()
            broker_a.link_peer("beta", broker_b.root.read_endpoint())
            self.assertTrue(wait_until(lambda: "alpha" in broker_b._peers))
            self.assertTrue(wait_until(lambda: any(
                a.get("id") == "alpha:caller"
                for a in broker_b._remote.get("alpha", []))))
            fork = TeamClient(root_b, heartbeat=None)
            fork.id = "beta:fork-keep"
            fork.role = "fork"
            fork.parent = "alpha:caller"
            fork.owner_pid = str(dummy.pid)
            fork.register()
            # A stale link dropping must not reap the live link's forks.
            stale = PeerLink(broker_b, "alpha", conn=None)
            broker_b._peer_down(stale)
            time.sleep(1.0)
            self.assertIsNone(dummy.poll(),
                              "a stale link drop reaped a live fork")
            self.assertIn("beta:fork-keep", self._ids_via(root_b))
            # Pending relays for the host are purged when the live link
            # finally drops, and its forks are reaped.
            probe = TeamClient(root_b, heartbeat=None)
            probe.id = "beta:probe"
            probe.register()
            broker_b._peer_pending["rid-x"] = (
                probe._conn, broker_b._peers["alpha"], time.time())
            broker_a.stop()
            thread_a.join(timeout=3)
            self.assertTrue(wait_until(
                lambda: "rid-x" not in broker_b._peer_pending),
                "pending relay leaked past peer down")
            self.assertTrue(
                wait_until(lambda: dummy.poll() is not None, timeout=6),
                "remote fork not reaped on peer down")
        finally:
            broker_b.stop()
            thread_b.join(timeout=3)
            try:
                dummy.kill()
            except OSError:
                pass
            dummy.wait(timeout=5)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def test_remote_fork_reaped_when_parent_disconnects(self):
        root_a = make_root()
        root_b = make_root()
        broker_a, thread_a = self._start_broker(root_a, "alpha")
        broker_b, thread_b = self._start_broker(root_b, "beta")
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        try:
            caller = TeamClient(root_a, heartbeat=0.2)
            caller.id = "alpha:caller"
            caller.role = "main"
            caller.register()
            broker_a.link_peer("beta", broker_b.root.read_endpoint())
            self.assertTrue(wait_until(lambda: "alpha" in broker_b._peers))
            self.assertTrue(wait_until(lambda: any(
                a.get("id") == "alpha:caller"
                for a in broker_b._remote.get("alpha", []))))
            fork = TeamClient(root_b, heartbeat=None)
            fork.id = "beta:fork-live"
            fork.role = "fork"
            fork.parent = "alpha:caller"
            fork.owner_pid = str(dummy.pid)
            fork.register()
            time.sleep(1.0)
            self.assertIsNone(dummy.poll(),
                              "fork reaped while its parent was live")
            # The requesting agent's session ends: only its connection
            # drops while the peer link stays up.
            caller.close()
            self.assertTrue(
                wait_until(lambda: dummy.poll() is not None, timeout=6),
                "remote fork not reaped when its parent disconnected")
            self.assertTrue(wait_until(
                lambda: "beta:fork-live" not in self._ids_via(root_b)))
            self.assertIn("alpha", broker_b._peers)
        finally:
            broker_a.stop()
            broker_b.stop()
            thread_a.join(timeout=3)
            thread_b.join(timeout=3)
            try:
                dummy.kill()
            except OSError:
                pass
            dummy.wait(timeout=5)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def test_broker_owns_ssh_tunnel_and_links_peer(self):
        root_a = make_root()
        root_b = make_root()
        broker_b, thread_b = self._start_broker(root_b, "beta")
        factory = RecordingTunnelFactory(root_b)
        broker_a, thread_a = self._start_broker(
            root_a, "alpha", tunnel_factory=factory)
        try:
            result = broker_a.add_peer("peer-b", "user@host")
            self.assertEqual(result["host"], "beta")
            self.assertTrue(factory.tunnels[0].started)
            self.assertEqual(factory.tunnels[0].label, "peer-b")
            self.assertTrue(
                wait_until(lambda: "alpha" in broker_b._peers),
                "peer link was never accepted")
            listed = broker_a.peer_list()
            self.assertEqual(len(listed), 1)
            self.assertEqual(listed[0]["label"], "peer-b")
            self.assertEqual(listed[0]["host"], "beta")
            self.assertTrue(listed[0]["online"])
            # Durable config survives so a restart can rebuild the tunnel.
            stored = broker_a.root.read_peers()
            self.assertEqual(stored["peer-b"],
                             {"ssh": "user@host", "host": "beta"})
            # An explicit removal closes the tunnel and drops the link.
            broker_a.remove_peer("peer-b")
            self.assertTrue(factory.tunnels[0].closed)
            self.assertTrue(
                wait_until(lambda: "alpha" not in broker_b._peers),
                "removed peer link stayed up")
            self.assertEqual(broker_a.peer_list(), [])
            self.assertEqual(broker_a.root.read_peers(), {})
        finally:
            broker_a.stop()
            broker_b.stop()
            thread_a.join(timeout=3)
            thread_b.join(timeout=3)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def test_tunnel_flap_drops_link_but_keeps_config(self):
        root_a = make_root()
        root_b = make_root()
        broker_b, thread_b = self._start_broker(root_b, "beta")
        factory = RecordingTunnelFactory(root_b)
        broker_a, thread_a = self._start_broker(
            root_a, "alpha", tunnel_factory=factory)
        try:
            broker_a.add_peer("peer-b", "user@host")
            self.assertTrue(wait_until(
                lambda: broker_a.peer_list()[0]["online"]))
            # ssh exits on its own: the link drops, the config is kept.
            factory.tunnels[0].flap()
            self.assertTrue(wait_until(
                lambda: not broker_a.peer_list()[0]["online"]))
            self.assertNotIn("beta", broker_a._peers)
            self.assertEqual(
                broker_a.root.read_peers()["peer-b"]["ssh"], "user@host")
        finally:
            broker_a.stop()
            broker_b.stop()
            thread_a.join(timeout=3)
            thread_b.join(timeout=3)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def test_persisted_peers_rebuild_on_start(self):
        root_a = make_root()
        root_b = make_root()
        broker_b, thread_b = self._start_broker(root_b, "beta")
        factory = RecordingTunnelFactory(root_b)
        broker_a, thread_a = self._start_broker(
            root_a, "alpha", tunnel_factory=factory)
        try:
            broker_a.add_peer("peer-b", "user@host")
            broker_a.stop()
            thread_a.join(timeout=3)
            # A fresh broker on the same root restores the link it owns.
            factory2 = RecordingTunnelFactory(root_b)
            broker_a2, thread_a2 = self._start_broker(
                root_a, "alpha", tunnel_factory=factory2)
            try:
                self.assertTrue(wait_until(
                    lambda: broker_a2.peer_list()
                    and broker_a2.peer_list()[0]["online"]),
                    "persisted peer was not rebuilt")
                self.assertEqual(factory2.tunnels[0].ssh, "user@host")
            finally:
                broker_a2.stop()
                thread_a2.join(timeout=3)
        finally:
            broker_b.stop()
            thread_b.join(timeout=3)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def test_terminate_routes_to_peer_host(self):
        root_a = make_root()
        root_b = make_root()
        broker_a, thread_a = self._start_broker(root_a, "alpha")
        broker_b, thread_b = self._start_broker(root_b, "beta")
        try:
            victim = TeamClient(root_b, heartbeat=None)
            victim.id = "beta:victim"
            victim.role = "cli"
            victim.register()
            self.assertTrue(wait_until(
                lambda: "beta:victim" in self._ids_via(root_b)))
            broker_a.link_peer("beta", broker_b.root.read_endpoint())
            self.assertTrue(wait_until(lambda: "alpha" in broker_b._peers))
            caller = TeamClient(root_a, heartbeat=None)
            caller.id = "alpha:caller"
            caller.register()
            reply = caller.terminate("beta:victim", "requested")
            self.assertEqual(reply.get("op"), "ack", reply)
            self.assertTrue(wait_until(
                lambda: "beta:victim" not in self._ids_via(root_b)),
                "remote agent was not evicted")
            caller.close()
        finally:
            broker_a.stop()
            broker_b.stop()
            thread_a.join(timeout=3)
            thread_b.join(timeout=3)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def test_mutual_add_keeps_one_healthy_link(self):
        # The smaller host adds first; the larger host then adds too. The
        # pair must settle on the smaller host's outbound link instead of
        # tearing each other's link down.
        root_a = make_root()
        root_b = make_root()
        broker_b, thread_b = self._start_broker(
            root_b, "bbb", tunnel_factory=RecordingTunnelFactory(root_a))
        broker_a, thread_a = self._start_broker(
            root_a, "aaa", tunnel_factory=RecordingTunnelFactory(root_b))
        try:
            broker_a.add_peer("p", "u@h")
            self.assertTrue(wait_until(
                lambda: broker_b._peers.get("aaa") is not None))
            broker_b.add_peer("p", "u@h")
            time.sleep(0.5)
            self.assertTrue(broker_a.peer_list()[0]["online"],
                            "aaa lost its link after a mutual add")
            self.assertTrue(broker_b.peer_list()[0]["online"],
                            "bbb lost its link after a mutual add")
            self.assertTrue(broker_a._peers["bbb"].connected)
            self.assertTrue(broker_b._peers["aaa"].connected)
            self.assertIn("p", broker_a.root.read_peers())
            self.assertIn("p", broker_b.root.read_peers())
        finally:
            broker_a.stop()
            broker_b.stop()
            thread_a.join(timeout=3)
            thread_b.join(timeout=3)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def test_mutual_add_reverse_order_keeps_config(self):
        # The larger host adds first, then the smaller host takes over the
        # outbound direction; both keep a durable peer entry.
        root_a = make_root()
        root_b = make_root()
        broker_b, thread_b = self._start_broker(
            root_b, "bbb", tunnel_factory=RecordingTunnelFactory(root_a))
        broker_a, thread_a = self._start_broker(
            root_a, "aaa", tunnel_factory=RecordingTunnelFactory(root_b))
        try:
            broker_b.add_peer("p", "u@h")
            self.assertTrue(wait_until(
                lambda: broker_a._peers.get("bbb") is not None))
            broker_a.add_peer("p", "u@h")
            time.sleep(0.5)
            self.assertTrue(broker_a.peer_list()[0]["online"])
            self.assertTrue(broker_b.peer_list()[0]["online"])
            self.assertIn("p", broker_a.root.read_peers())
            self.assertIn("p", broker_b.root.read_peers())
        finally:
            broker_a.stop()
            broker_b.stop()
            thread_a.join(timeout=3)
            thread_b.join(timeout=3)
            shutil.rmtree(root_a, ignore_errors=True)
            shutil.rmtree(root_b, ignore_errors=True)

    def _ids_via(self, root):
        probe = TeamClient(root, heartbeat=None)
        probe.id = "probe"
        reply = probe.ls()
        probe.close()
        return {a["id"] for a in reply["agents"]}


if __name__ == "__main__":
    unittest.main()