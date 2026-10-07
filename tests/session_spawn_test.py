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

    def __init__(self, ok=True, hosts=True):
        self.ok = ok
        self.hosts = hosts
        self.calls = []
        self.stopped = []

    def start(self, session, cwd, argv, env, env_once=None):
        self.calls.append({"session": session, "cwd": cwd, "argv": argv,
                           "env": env, "env_once": env_once})
        if not self.ok:
            return {"ok": False, "error": "refused"}
        return {"ok": True, "name": session}

    def state(self, session):
        if not self.ok or not self.hosts:
            return None
        return {"name": session, "state": "idle"}

    def stop(self, session):
        self.stopped.append(session)
        return {"ok": True}


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

    def __init__(self, hosts=True):
        self.hosts = hosts
        self.spawns = []
        self.abandoned = []

    def task_prompt(self, session, task):
        return "TASK:%s:%s" % (session, task)

    def spawn(self, task, fork_id, **kw):
        self.spawns.append((task, fork_id, kw))
        return fork_id

    def hosted(self, key):
        return {"key": key} if self.hosts else None

    def abandon(self, key):
        self.abandoned.append(key)


class TeamSpawnerTests(unittest.TestCase):
    def _spawner(self, client=None, error=None, self_host=None, host=None):
        fake_self = self_host or FakeSelfHost()
        spawner = TeamSpawner(
            TeamRoot(make_root()), environ={},
            resolver_factory=lambda fallback: FakeResolver(client, error),
            self_host=fake_self, confirm_timeout=0.0, host=host)
        return spawner, fake_self

    def test_host_prefixes_the_minted_id(self):
        # Peers route by the id's host prefix, so a spawned teammate
        # must carry its host label; the teammate adopts this id as
        # TEAM_ID, and a bare id reads as local on the wrong host.
        client = FakeClient()
        spawner, _ = self._spawner(client=client, host="alpha")
        ref = spawner.spawn("alpha:parent", "do it", parent_pid="1234",
                            name="t4")
        self.assertTrue(ref["id"].startswith("alpha:fork-1234-"), ref["id"])
        self.assertEqual(client.calls[0]["env"]["TEAM_ID"], ref["id"])

    def test_no_host_mints_a_bare_id(self):
        # The standalone spawner (no host label known) keeps the bare
        # form rather than a dangling ':'.
        client = FakeClient()
        spawner, _ = self._spawner(client=client)
        ref = spawner.spawn("alpha:parent", "do it", parent_pid="1234",
                            name="t5")
        self.assertTrue(ref["id"].startswith("fork-1234-"), ref["id"])

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
        # The secret is never in the persisted env the provider stores.
        self.assertNotIn("TEAM_SEND_TOKEN", call["env"])
        self.assertTrue(call["env_once"]["TEAM_SEND_TOKEN"])
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
        # A refused start created nothing, so nothing is reclaimed.
        self.assertEqual(client.stopped, [])

    def test_a_provider_session_that_does_not_host_is_reclaimed(self):
        client = FakeClient(hosts=False)
        spawner, fake_self = self._spawner(client=client)
        ref = spawner.spawn("alpha:parent", "x", name="t4")
        self.assertEqual(ref["served"], "self")
        self.assertEqual(client.stopped, ["t4"])
        self.assertEqual(len(fake_self.spawns), 1)

    def test_no_hosting_path_raises_instead_of_acking(self):
        client = FakeClient(hosts=False)
        spawner, fake_self = self._spawner(
            client=client, self_host=FakeSelfHost(hosts=False))
        with self.assertRaises(OSError):
            spawner.spawn("alpha:parent", "x", name="t5")
        self.assertEqual(client.stopped, ["t5"])
        self.assertEqual(fake_self.abandoned, [fake_self.spawns[0][1]])


if __name__ == "__main__":
    unittest.main()
