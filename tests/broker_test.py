"""Broker protocol tests: handshake, registry, relay, liveness."""

import json
import shutil
import socket
import threading
import unittest

from harness import make_root, wait_endpoint, wait_until
from team import TeamClient
from teamd import TeamBroker

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

    def _ids_via(self, root):
        probe = TeamClient(root, heartbeat=None)
        probe.id = "probe"
        reply = probe.ls()
        probe.close()
        return {a["id"] for a in reply["agents"]}


if __name__ == "__main__":
    unittest.main()