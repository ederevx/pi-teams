"""Cross-host attach tests: an attached live session keeps the
parent-gone lifetime but is exempt from fork-idle GC, and its session
transcript survives the reaping."""

import json
import os
import shutil
import subprocess
import sys
import threading
import unittest

from harness import make_root, wait_endpoint, wait_until
from team import TeamClient
from teamd import TeamBroker

IDLE_ROOMY = 30.0
FORK_IDLE_SHORT = 0.6


class FakeTunnel:
    """A PeerTunnel stand-in that links to a real peer endpoint."""

    def __init__(self, label, ssh, endpoint):
        self.label = label
        self.ssh = ssh
        self.host = endpoint.get("name") or label
        self.closed = False
        self.started = False
        self._endpoint = endpoint

    def start(self):
        self.started = True
        return {"host": self._endpoint["host"],
                "port": self._endpoint["port"],
                "token": self._endpoint["token"], "name": self.host}

    def close(self):
        self.closed = True


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

    def _start_broker(self, root, host, fork_idle=IDLE_ROOMY):
        sessions = os.path.join(root, "sessions")
        os.makedirs(sessions, exist_ok=True)
        # gc_ping_grace=0: these tests assert reap timing, not the
        # finish-query courtesy, so the query is disabled.
        broker = TeamBroker(root, idle_timeout=IDLE_ROOMY,
                            sweep_interval=0.1, host=host,
                            fork_idle=fork_idle, gc_ping_grace=0,
                            sessions_root=sessions, session_grace=0.3)
        thread = threading.Thread(target=broker.run, daemon=True)
        thread.start()
        wait_endpoint(root)
        self.brokers.append(broker)
        self.threads.append(thread)
        return broker

    def setUpPeers(self, fork_idle=FORK_IDLE_SHORT):
        self.root_a = make_root()
        self.root_b = make_root()
        self.sessions_b = os.path.join(self.root_b, "sessions")
        os.makedirs(self.sessions_b, exist_ok=True)
        self.broker_a = self._start_broker(self.root_a, "alpha",
                                           fork_idle=IDLE_ROOMY)
        self.broker_b = self._start_broker(self.root_b, "beta",
                                           fork_idle=fork_idle)
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
        self.assertEqual(client.register().get("op"), "ack")
        return client

    def test_attached_session_is_exempt_from_fork_idle_gc(self):
        self.setUpPeers()
        attached_proc = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        spawned_proc = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        self.procs.extend((attached_proc, spawned_proc))
        parent = self._register(self.root_a, "alpha:main", "main",
                                heartbeat=0.2)
        # The extension's attach re-registers the target as a fork whose
        # parent lives on the peer host; the hold carries TEAM_ATTACHED.
        self._register(
            self.root_b, "beta:fork-1", "fork", parent="alpha:main",
            owner_pid=str(attached_proc.pid), session="beta-attached.jsonl",
            attached=True, heartbeat=0.2)
        self._register(
            self.root_b, "beta:fork-2", "fork", parent="alpha:main",
            owner_pid=str(spawned_proc.pid), session="beta-spawned.jsonl",
            attached=False, heartbeat=0.2)
        # Both forks go idle; only the spawned one is reaped by the
        # fork-idle clock, because the attached session was not created
        # for one task and keeps the parent-gone lifetime instead.
        self.assertTrue(wait_until(
            lambda: "beta:fork-2" not in self._ids_b(), timeout=8),
            "spawned fork was not reaped by fork-idle GC")
        self.assertTrue(wait_until(
            lambda: spawned_proc.poll() is not None, timeout=3),
            "spawned fork was not signalled by fork-idle GC")
        self.assertIsNone(attached_proc.poll(),
                          "attached fork was reaped by fork-idle GC")
        self.assertIn("beta:fork-1", self._ids_b())

    def test_attached_session_dies_with_parent_and_keeps_session(self):
        self.setUpPeers(fork_idle=IDLE_ROOMY)
        dummy = subprocess.Popen(
            [sys.executable, "-c", "import os, time; time.sleep(60)"])
        self.procs.append(dummy)
        session_path = os.path.join(
            self.sessions_b, "beta-attached.jsonl")
        with open(session_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"role": "user", "content": "hi"}))
        parent = self._register(self.root_a, "alpha:main", "main",
                                heartbeat=0.2)
        self._register(
            self.root_b, "beta:fork-1", "fork", parent="alpha:main",
            owner_pid=str(dummy.pid), session=session_path,
            attached=True, heartbeat=0.2)
        self.assertIsNone(dummy.poll())
        # The parent goes away: the target broker owns the GC and reaps
        # the attached fork, signals its process, and keeps the session
        # transcript (no spawn marker) for /resume.
        parent.deregister()
        self.assertTrue(wait_until(lambda: dummy.poll() is not None,
                                   timeout=6),
                        "attached fork not reaped when parent went away")
        self.assertTrue(wait_until(
            lambda: "beta:fork-1" not in self._ids_b(), timeout=6))
        self.assertTrue(os.path.exists(session_path),
                        "attached session transcript was removed")

    def _ids_b(self):
        client = TeamClient(self.root_b)
        registry = client.ls()
        return {a["id"] for a in registry["agents"]}


if __name__ == "__main__":
    unittest.main()
