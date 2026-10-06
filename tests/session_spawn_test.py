"""TeamSpawner tests: binding to a provider, self-provisioning when no
provider answers, and the identity every path hands the teammate.

The provider and the self-host fallback are injected, so no daemon or
real pi process is needed.
"""

import unittest

from harness import make_root
from session_spawn import TeamSpawner
from team_root import TeamRoot


class FakeClient:
    """A session-host client recording each start request."""

    def __init__(self, ok=True):
        self.ok = ok
        self.calls = []

    def start(self, session, cwd, argv, env):
        self.calls.append({"session": session, "cwd": cwd, "argv": argv,
                           "env": env})
        if not self.ok:
            return {"ok": False, "error": "refused"}
        return {"ok": True, "name": session}


class FakeResolver:
    """Resolves to a client or raises, standing in for the binder."""

    def __init__(self, client=None, error=None):
        self.client = client
        self.error = error

    def resolve(self):
        if self.error:
            raise OSError(self.error)
        return self.client


class FakeSelfHost:
    """Records self-provision spawns; owns the prompt text."""

    def __init__(self):
        self.spawns = []

    def task_prompt(self, session, task):
        return "TASK:%s:%s" % (session, task)

    def spawn(self, task, fork_id, **kw):
        self.spawns.append((task, fork_id, kw))
        return fork_id


class TeamSpawnerTests(unittest.TestCase):
    def _spawner(self, client=None, error=None, self_host=None):
        fake_self = self_host or FakeSelfHost()
        spawner = TeamSpawner(
            TeamRoot(make_root()), environ={},
            resolver_factory=lambda fallback: FakeResolver(client, error),
            self_host=fake_self)
        return spawner, fake_self

    def test_provider_path_carries_identity_and_task(self):
        client = FakeClient()
        spawner, fake_self = self._spawner(client=client)
        ref = spawner.spawn("alpha:parent", "do it", parent_pid="1234",
                            name="t1", cwd="/work")
        self.assertEqual(ref["served"], "provider")
        self.assertEqual(ref["session"], "t1")
        self.assertTrue(ref["id"].startswith("fork-1234-"))
        call = client.calls[0]
        self.assertEqual(call["session"], "t1")
        self.assertEqual(call["cwd"], "/work")
        self.assertEqual(call["argv"][-1], "TASK:t1:do it")
        self.assertEqual(call["env"]["TEAM_ID"], ref["id"])
        self.assertEqual(call["env"]["TEAM_PARENT_ID"], "alpha:parent")
        self.assertEqual(call["env"]["TEAM_ROLE"], "fork")
        self.assertTrue(call["env"]["TEAM_SEND_TOKEN"])
        self.assertEqual(fake_self.spawns, [])

    def test_no_provider_self_provisions(self):
        spawner, fake_self = self._spawner(error="no session-host provider")
        ref = spawner.spawn("alpha:parent", "do it", name="t2")
        self.assertEqual(ref["served"], "self")
        self.assertEqual(len(fake_self.spawns), 1)
        task, fork_id, kw = fake_self.spawns[0]
        self.assertEqual(task, "do it")
        self.assertEqual(fork_id, ref["id"])
        self.assertEqual(kw["session"], "t2")
        self.assertEqual(kw["parent_id"], "alpha:parent")
        self.assertTrue(kw["send_token"])

    def test_provider_refusal_falls_back(self):
        client = FakeClient(ok=False)
        spawner, fake_self = self._spawner(client=client)
        ref = spawner.spawn("alpha:parent", "x", name="t3")
        self.assertEqual(ref["served"], "self")
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(len(fake_self.spawns), 1)


if __name__ == "__main__":
    unittest.main()
