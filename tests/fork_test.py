"""Fork lifecycle tests: a fork goes away with its parent's connection."""

import json
import shutil
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
from team import TeamClient


class ForkLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.proc = start_broker(self.root, idle_timeout=15.0)

    def tearDown(self):
        stop_broker(self.root, self.proc)
        shutil.rmtree(self.root, ignore_errors=True)

    def _ids(self):
        _, out, _ = run_team(self.root, ["ls"])
        registry = json.loads(out)
        return {a["id"] for a in registry["agents"]}

    def _parent(self, agent_id):
        parent = TeamClient(self.root)
        parent.id = agent_id
        parent.name = agent_id
        parent.role = "main"
        reply = parent.register()
        self.assertEqual(reply.get("op"), "ack", reply)
        return parent

    def _spawn_fork(self, agent_id, parent_id):
        return team_proc(
            self.root,
            ["hold"],
            env={
                "TEAM_ID": agent_id,
                "TEAM_PARENT_ID": parent_id,
                "TEAM_ROLE": "fork",
            },
        )

    def test_hold_identity_args(self):
        # pi.exec cannot forward env to the hold, so identity must ride
        # in as CLI arguments and land in the registry verbatim.
        holder = team_proc(
            self.root,
            ["hold", "--id", "ident-1", "--role", "fork",
             "--parent", "p-9", "--name", "ident-one"],
        )
        try:
            self.assertTrue(
                wait_until(lambda: "ident-1" in self._ids(), timeout=3),
                "hold with --id never registered",
            )
            _, out, _ = run_team(self.root, ["ls"])
            entry = next(a for a in json.loads(out)["agents"]
                         if a["id"] == "ident-1")
            self.assertEqual(entry["role"], "fork")
            self.assertEqual(entry["parent"], "p-9")
            self.assertEqual(entry["name"], "ident-one")
        finally:
            run_team(self.root, ["terminate", "ident-1"])
            holder.wait(timeout=5)

    def test_fork_lives_while_parent_connected(self):
        parent = self._parent("parent-1")
        child = self._spawn_fork("fork-1", "parent-1")
        try:
            self.assertTrue(
                wait_until(lambda: "fork-1" in self._ids(), timeout=3),
                "fork never registered",
            )
            time.sleep(1.2)
            self.assertIsNone(child.poll(), "fork died while parent connected")
            self.assertIn("fork-1", self._ids())
        finally:
            child.kill()
            child.wait(timeout=5)
            parent.close()

    def test_fork_dies_when_parent_connection_closes(self):
        parent = self._parent("parent-2")
        child = self._spawn_fork("fork-2", "parent-2")
        self.assertTrue(
            wait_until(lambda: "fork-2" in self._ids(), timeout=3),
            "fork never registered",
        )
        parent.close()
        self.assertTrue(
            wait_until(lambda: child.poll() is not None, timeout=6),
            "fork still alive after its parent went away",
        )

    def test_explicit_terminate(self):
        parent = self._parent("parent-3")
        child = self._spawn_fork("fork-3", "parent-3")
        self.assertTrue(
            wait_until(lambda: "fork-3" in self._ids(), timeout=3),
            "fork never registered",
        )
        _, out, err = run_team(self.root, ["terminate", "fork-3"])
        self.assertIn('"op": "ack"', out, err)
        self.assertTrue(
            wait_until(lambda: child.poll() is not None, timeout=6),
            "fork survived an explicit terminate",
        )
        parent.close()


if __name__ == "__main__":
    unittest.main()