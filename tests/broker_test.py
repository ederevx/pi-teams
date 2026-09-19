"""Broker protocol tests: registration, relay, discovery, cleanup."""

import shutil
import subprocess
import sys
import threading
import unittest

from harness import make_root, wait_sock, wait_until
from team import TeamClient
from teamd import TeamBroker


class BrokerProtocolTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.broker = TeamBroker(self.root, sweep_interval=0.1)
        self.thread = threading.Thread(target=self.broker.run, daemon=True)
        self.thread.start()
        wait_sock(self.root)
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

    def test_sweep_removes_dead_pid(self):
        self._agent("ghost")
        died = subprocess.Popen([sys.executable, "-c", "pass"])
        died.wait(timeout=5)
        ghost = TeamClient(self.root)
        ghost.id = "ghost"
        ghost.forced_pid = str(died.pid)
        ghost.register()
        self.assertTrue(
            wait_until(lambda: "ghost" not in self._agents()),
            "dead-pid agent was never swept",
        )


if __name__ == "__main__":
    unittest.main()