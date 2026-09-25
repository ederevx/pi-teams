"""Cross-host attach tests: an attached live session shares the single
idle window with a spawned fork, and its session transcript survives the
voluntary reap."""

import json
import os
import shutil
import subprocess
import sys
import threading
import unittest

from harness import make_root, wait_endpoint, wait_until
from team import TeamClient
from teamd import TEAMMATE_MARKER, TeamBroker

IDLE_ROOMY = 30.0
FORK_IDLE_SHORT = 0.6


class AttachCrossHostTests(unittest.TestCase):
    def setUp(self):
        self.brokers = []
        self.threads = []
        self.procs = []

    def tearDown(self):
        for broker in self.brokers:
            broker.stop()
        for thread in self.threads:
            thread.join(timeout=3)
        for proc in self.procs:
            try:
                proc.kill()
            except OSError:
                pass
            proc.wait(timeout=5)
        for attr in ("root_a", "root_b", "sessions_b"):
            shutil.rmtree(getattr(self, attr, "/nonexistent"),
                          ignore_errors=True)

    def _start_broker(self, root, host, gc_idle=IDLE_ROOMY):
        sessions = os.path.join(root, "sessions")
        os.makedirs(sessions, exist_ok=True)
        broker = TeamBroker(root, idle_timeout=IDLE_ROOMY,
                            sweep_interval=0.1, host=host,
                            gc_idle=gc_idle,
                            sessions_root=sessions, session_grace=0.3)
        thread = threading.Thread(target=broker.run, daemon=True)
        thread.start()
        wait_endpoint(root)
        self.brokers.append(broker)
        self.threads.append(thread)
        return broker

    def setUpPeers(self, gc_idle=FORK_IDLE_SHORT):
        self.root_a = make_root()
        self.root_b = make_root()
        self.sessions_b = os.path.join(self.root_b, "sessions")
        os.makedirs(self.sessions_b, exist_ok=True)
        self.broker_a = self._start_broker(self.root_a, "alpha",
                                           gc_idle=IDLE_ROOMY)
        self.broker_b = self._start_broker(self.root_b, "beta",
                                           gc_idle=gc_idle)
        self.assertTrue(self.broker_a.link_peer(
            "beta", self.broker_b.root.read_endpoint()))
        self.assertTrue(wait_until(lambda: "alpha" in self.broker_b._peers))

    def _register(self, root, agent_id, role, parent=None, owner_pid=None,
                  session=None, attached=False, heartbeat=None):
        client = TeamClient(root, heartbeat=heartbeat)
        client.id = agent_id
        client.role = role
        if parent:
            client.parent = parent
        if owner_pid:
            client.owner_pid = owner_pid
        if session:
            client.session = session
        client.attached = attached
        client.send_token = "st-%s" % agent_id
        self.assertEqual(client.register().get("op"), "ack")
        return client

    def test_attached_and_spawned_share_the_single_idle_window(self):
        # The one idle policy no longer distinguishes an attached
        # session from a spawned one: both are asked to reap themselves
        # at the same window, and neither is force-killed.
        self.setUpPeers(gc_idle=FORK_IDLE_SHORT)
        attached_proc = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        spawned_proc = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        self.procs.extend((attached_proc, spawned_proc))
        self._register(self.root_a, "alpha:main", "main", heartbeat=0.2)
        self._register(
            self.root_b, "beta:fork-1", "fork", parent="alpha:main",
            owner_pid=str(attached_proc.pid), session="beta-attached.jsonl",
            attached=True, heartbeat=0.2)
        self._register(
            self.root_b, "beta:fork-2", "fork", parent="alpha:main",
            owner_pid=str(spawned_proc.pid), session="beta-spawned.jsonl",
            attached=False, heartbeat=0.2)
        self.assertTrue(wait_until(
            lambda: {"beta:fork-1", "beta:fork-2"}
            <= self.broker_b.gc._requested, timeout=6),
            "the single idle window did not request both sessions")
        # The reaper only requests; the sessions answer themselves.
        self.assertIsNone(attached_proc.poll())
        self.assertIsNone(spawned_proc.poll())
        self.assertIn("beta:fork-1", self._ids_b())
        self.assertIn("beta:fork-2", self._ids_b())

    def test_voluntary_reap_keeps_attached_and_removes_spawned_session(self):
        # Answering the reap drops the registration; a spawned
        # teammate's marked transcript goes with it, an attached
        # session's unmarked transcript stays for /resume. The broker
        # never signals on a voluntary reap: the session shuts itself
        # down.
        self.setUpPeers(gc_idle=IDLE_ROOMY)
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        self.procs.append(dummy)
        spawned = os.path.join(self.sessions_b, "beta-spawned.jsonl")
        with open(spawned, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "session", "id": spawned}) + "\n")
            fh.write(json.dumps({"type": "message", "role": "user",
                                 "content": TEAMMATE_MARKER}) + "\n")
        attached = os.path.join(self.sessions_b, "beta-attached.jsonl")
        with open(attached, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"role": "user", "content": "hi"}))
        self._register(self.root_a, "alpha:main", "main", heartbeat=0.2)
        self._register(
            self.root_b, "beta:fork-1", "fork", parent="alpha:main",
            owner_pid=str(dummy.pid), session=spawned, heartbeat=0.2)
        self._register(
            self.root_b, "beta:fork-2", "fork", parent="alpha:main",
            owner_pid=str(dummy.pid), session=attached, attached=True,
            heartbeat=0.2)
        for agent_id, session, kept in (
                ("beta:fork-1", spawned, False),
                ("beta:fork-2", attached, True)):
            acker = TeamClient(self.root_b)
            acker.id = agent_id
            acker.send_token = "st-%s" % agent_id
            self.assertEqual(acker.gc_reap().get("op"), "ack")
            acker.close()
            self.assertEqual(os.path.exists(session), kept, session)
            self.assertTrue(wait_until(
                lambda a=agent_id: a not in self._ids_b()))
        self.assertIsNone(dummy.poll(),
                          "a voluntary reap signalled the owner process")

    def _ids_b(self):
        client = TeamClient(self.root_b)
        registry = client.ls()
        return {a["id"] for a in registry["agents"]}


if __name__ == "__main__":
    unittest.main()
