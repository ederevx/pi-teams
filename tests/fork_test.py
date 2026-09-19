"""Fork lifecycle tests: a fork goes away with the parent that spawned it."""

import json
import shutil
import subprocess
import sys
import time
import unittest

from harness import (
    make_root,
    run_team,
    start_broker,
    stop_broker,
    team_proc,
    wait_until,
)

DUMMY = "import os, time; time.sleep(60)"


class ForkLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.proc = start_broker(self.root)

    def tearDown(self):
        stop_broker(self.root, self.proc)
        shutil.rmtree(self.root, ignore_errors=True)

    def _dummy(self):
        return subprocess.Popen([sys.executable, "-c", DUMMY])

    def _register_parent(self, agent_id, dummy):
        code, out, err = run_team(
            self.root,
            ["register"],
            env={
                "TEAM_ID": agent_id,
                "TEAM_PID": str(dummy.pid),
                "TEAM_ROLE": "main",
                "TEAM_NAME": agent_id,
            },
        )
        self.assertEqual(code, 0, err)
        self.assertIn('"op": "ack"', out, out)

    def _spawn_fork(self, agent_id, parent_id):
        return team_proc(
            self.root,
            ["child", "hold"],
            env={
                "TEAM_ID": agent_id,
                "TEAM_PARENT_ID": parent_id,
                "TEAM_ROLE": "fork",
            },
        )

    def _ids(self):
        _, out, _ = run_team(self.root, ["ls"])
        registry = json.loads(out)
        return {a["id"] for a in registry["agents"]}

    def test_fork_lives_while_parent_alive(self):
        dummy = self._dummy()
        try:
            self._register_parent("parent-1", dummy)
            child = self._spawn_fork("fork-1", "parent-1")
            self.assertTrue(
                wait_until(lambda: "fork-1" in self._ids(), timeout=3),
                "fork never registered",
            )
            time.sleep(1.2)
            self.assertIsNone(child.poll(), "fork died while parent lives")
            self.assertIn("fork-1", self._ids())
            child.kill()
            child.wait(timeout=5)
        finally:
            dummy.terminate()
            dummy.wait(timeout=5)

    def test_fork_dies_with_parent(self):
        dummy = self._dummy()
        self._register_parent("parent-2", dummy)
        child = self._spawn_fork("fork-2", "parent-2")
        self.assertTrue(
            wait_until(lambda: "fork-2" in self._ids(), timeout=3),
            "fork never registered",
        )
        dummy.terminate()
        dummy.wait(timeout=5)
        self.assertTrue(
            wait_until(lambda: child.poll() is not None, timeout=6),
            "fork still alive after its parent died",
        )
        self.assertTrue(
            wait_until(lambda: "fork-2" not in self._ids(), timeout=6),
            "fork never left the registry",
        )

    def test_fork_dies_with_parent_sigterm(self):
        dummy = self._dummy()
        self._register_parent("parent-3", dummy)
        child = self._spawn_fork("fork-3", "parent-3")
        self.assertTrue(
            wait_until(lambda: "fork-3" in self._ids(), timeout=3),
            "fork never registered",
        )
        dummy.kill()
        dummy.wait(timeout=5)
        self.assertTrue(
            wait_until(lambda: child.poll() is not None, timeout=6),
            "fork still alive after its parent was killed",
        )


if __name__ == "__main__":
    unittest.main()