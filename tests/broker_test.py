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

from harness import make_root, wait_endpoint, wait_until
from team import TeamClient
from teamd import PeerLink, TeamBroker

IDLE_ROOMY = 30.0


class BrokerProtocolTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.broker = TeamBroker(self.root, idle_timeout=IDLE_ROOMY,
                                 sweep_interval=0.2)
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

    def test_fork_idle_gc_kills_owner(self):
        root = make_root()
        broker = TeamBroker(root, idle_timeout=IDLE_ROOMY, fork_idle=0.3,
                            sweep_interval=0.1)
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
                            sweep_interval=0.1)
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
                            sweep_interval=0.1)
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

    def _start_broker(self, root, host):
        broker = TeamBroker(root, idle_timeout=IDLE_ROOMY,
                            sweep_interval=0.1, host=host)
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
            endpoint_b = broker_b.root.read_endpoint()
            broker_a.link_peer("beta", endpoint_b)
            self.assertTrue(wait_until(lambda: "alpha" in broker_b._peers))
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

    def test_replaced_peer_does_not_reap_current_forks(self):
        root_a = make_root()
        root_b = make_root()
        broker_a, thread_a = self._start_broker(root_a, "alpha")
        broker_b, thread_b = self._start_broker(root_b, "beta")
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        try:
            broker_a.link_peer("beta", broker_b.root.read_endpoint())
            self.assertTrue(wait_until(lambda: "alpha" in broker_b._peers))
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
            broker_b._peer_pending["rid-x"] = (probe._conn, "alpha")
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

    def _ids_via(self, root):
        probe = TeamClient(root, heartbeat=None)
        probe.id = "probe"
        reply = probe.ls()
        probe.close()
        return {a["id"] for a in reply["agents"]}


if __name__ == "__main__":
    unittest.main()