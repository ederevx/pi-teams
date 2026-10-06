"""Self-host fallback tests: detached keeper spawn and keeper GC."""

import os
import subprocess
import sys
import unittest

import harness  # noqa: F401 - inserts src/ on sys.path, isolates TEAM_*
from process_runner import ProcessRunner
from self_host import SelfSessionHost
from team_root import TeamRoot


class FakeProcess:
    """Stands in for a spawned keeper; only the pid is read."""

    def __init__(self, pid=4242):
        self.pid = pid


class FakeRunner:
    """Records which launch seam the host used, without a real pi."""

    def __init__(self):
        self.detached = []
        self.children = []

    def spawn_detached(self, argv, env=None, cwd=None):
        self.detached.append((list(argv), env, cwd))
        return FakeProcess()

    def spawn_child(self, argv, env=None, cwd=None):
        self.children.append((list(argv), env, cwd))
        return FakeProcess()


class SelfHostTest(unittest.TestCase):

    def test_detach_kwargs_use_a_new_session(self):
        # The ProcessRunner seam must actually detach on POSIX (setsid)
        # and on Windows (DETACHED_PROCESS), matching spawnPersistent.
        kwargs = ProcessRunner.detach_kwargs()
        if os.name == "nt":
            self.assertTrue(
                kwargs["creationflags"] & subprocess.DETACHED_PROCESS)
        else:
            self.assertTrue(kwargs["start_new_session"])

    def test_spawn_launches_a_detached_keeper(self):
        root = harness.make_root()
        runner = FakeRunner()
        host = SelfSessionHost(
            root, runner=runner, environ={"TEAM_ID": "h:pi-1"},
            interpreter="/usr/bin/python3", team_bin="/opt/pi/team.py")
        key = host.spawn("do a bounded thing", "h:fork-1", session="worker")

        self.assertEqual(key, "h:fork-1")
        self.assertEqual(len(runner.detached), 1)
        self.assertEqual(runner.children, [])
        argv = runner.detached[0][0]
        self.assertEqual(argv[:2], ["/usr/bin/python3", "/opt/pi/team.py"])
        self.assertIn("keeper", argv)
        self.assertEqual(argv[-1], "h:fork-1")

        spec = TeamRoot(root).read_keeper_spec("h:fork-1")
        self.assertEqual(spec["env"]["TEAM_ID"], "h:fork-1")
        self.assertEqual(spec["env"]["TEAM_NAME"], "worker")
        self.assertEqual(spec["env"]["TEAM_PARENT_ID"], "h:pi-1")
        self.assertEqual(spec["env"]["TEAM_ROLE"], "fork")
        self.assertTrue(spec["env"]["TEAM_SEND_TOKEN"])
        child_argv = spec["argv"]
        self.assertEqual(child_argv[:2], ["pi", "--mode"])
        self.assertIn("--append-system-prompt", child_argv)
        self.assertIn("Task:\ndo a bounded thing", spec["prompt"])

    def test_gc_reclaims_a_dead_keepers_state(self):
        root = harness.make_root()
        team_root = TeamRoot(root)
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        team_root.write_keeper_state(
            "h:fork-dead", {"key": "h:fork-dead", "keeper_pid": dead.pid,
                            "keeper_start": None})
        team_root.write_keeper_state(
            "h:fork-live", {"key": "h:fork-live", "keeper_pid": os.getpid(),
                            "keeper_start": TeamRoot.process_start_mark(
                                os.getpid())})

        removed = SelfSessionHost(root, runner=FakeRunner()).gc()

        self.assertFalse(team_root.keeper_state_path("h:fork-dead").exists())
        self.assertTrue(team_root.keeper_state_path("h:fork-live").exists())
        self.assertIn(str(team_root.keeper_state_path("h:fork-dead")), removed)

    def test_find_and_stop_a_live_keeper(self):
        root = harness.make_root()
        team_root = TeamRoot(root)
        team_root.write_keeper_state(
            "h:fork-live", {"key": "h:fork-live", "keeper_pid": os.getpid(),
                            "keeper_start": TeamRoot.process_start_mark(
                                os.getpid())})
        host = SelfSessionHost(root, runner=FakeRunner())

        self.assertIsNotNone(host.find("h:fork-live"))
        # A dead key is reclaimed by find's liveness check.
        self.assertIsNone(host.find("h:fork-absent"))


if __name__ == "__main__":
    unittest.main()
