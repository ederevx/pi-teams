"""Fork lifecycle tests: a fork goes away with its parent's connection."""

import json
import os
import shutil
import subprocess
import threading
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
        parent.send_token = "st-%s" % agent_id
        reply = parent.register()
        self.assertEqual(reply.get("op"), "ack", reply)
        return parent

    def _spawn_fork(self, agent_id, parent_id):
        # The hold inherits a stdin pipe from the spawner; the extension
        # owns that pipe so the endpoint dies with the pi it serves.
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

    def test_hold_surfaces_inbound_messages(self):
        # A relayed message must reach the hosting extension (the client
        # prints it on stdout), so a teammate can report back to the
        # parent instead of messages being silently dropped.
        parent = self._parent("parent-m")
        child = self._spawn_fork("fork-m", "parent-m")
        try:
            self.assertTrue(
                wait_until(lambda: "fork-m" in self._ids(), timeout=3),
                "fork never registered",
            )
            # The report rides the registered parent's credential; an
            # anonymous CLI sender is refused by the send gate.
            parent.send_msg("fork-m", "result", "report")
            lines = []
            reader = threading.Thread(
                target=lambda: lines.append(child.stdout.readline()),
                daemon=True,
            )
            reader.start()
            reader.join(timeout=3)
            self.assertTrue(lines, "hold did not surface the message")
            msg = json.loads(lines[0])
            self.assertEqual(msg["op"], "message")
            self.assertEqual(msg["to"], "fork-m")
            self.assertEqual(msg["kind"], "result")
            self.assertEqual(msg["payload"], "report")
        finally:
            child.kill()
            child.wait(timeout=5)
            parent.close()

    def test_send_identity_arg_stamps_the_sender(self):
        # send must carry the caller's real id and its send token: a
        # peer's spawn handler replies to `from`, and a remote fork is
        # parented to it, so a throwaway cli id would strand the reply
        # and the fork - and the gate refuses an unregistered sender.
        holder = team_proc(
            self.root,
            ["hold", "--id", "target-1", "--role", "main"],
        )
        sender = TeamClient(self.root)
        sender.id = "sender-1"
        sender.name = "sender-1"
        sender.send_token = "st-sender-1"
        sender.register()
        try:
            self.assertTrue(
                wait_until(lambda: "target-1" in self._ids(), timeout=3),
                "hold never registered",
            )
            run_team(self.root, [
                "send", "--id", "sender-1",
                "--send-token", "st-sender-1",
                "target-1", "text", "hello",
            ])
            lines = []
            reader = threading.Thread(
                target=lambda: lines.append(holder.stdout.readline()),
                daemon=True,
            )
            reader.start()
            reader.join(timeout=3)
            self.assertTrue(lines, "hold did not surface the message")
            msg = json.loads(lines[0])
            self.assertEqual(msg["from"], "sender-1")
            self.assertEqual(msg["to"], "target-1")
        finally:
            sender.close()
            holder.kill()
            holder.wait(timeout=5)

    def test_hold_exits_when_hosted_stdin_closes(self):
        # The extension must own a stdin pipe for the hold: the client
        # treats EOF on stdin as "the pi that hosted me is gone" and
        # exits, so a hold launched with an already-closed stdin
        # (pi.exec's /dev/null) must not linger as an orphan.
        child = team_proc(
            self.root,
            ["hold", "--id", "detached-1", "--role", "main"],
            stdin=subprocess.DEVNULL,
        )
        try:
            child.wait(timeout=6)
            self.assertIsNotNone(
                child.poll(), "hold survived an already-closed stdin"
            )
        finally:
            child.kill()
            child.wait(timeout=5)

    def test_hold_answers_working_with_finish_yes(self):
        # The hold's answer polarity: a busy or waiting agent is still
        # working, so it must answer "finish-yes" (spared); answering
        # "finish-no" would reap a working fork at once. An idle hold
        # never answers; it surfaces the query for the agent's turn.
        for value, state in (("1", "busy"), ("2", "waiting"),
                             ("0", "idle")):
            busy = os.path.join(self.root, "%s.busy" % state)
            with open(busy, "w") as fh:
                fh.write(value)
            client = TeamClient(self.root, heartbeat=None)
            client.id = "fork-hold"
            client.busy_file = busy
            sent = []
            client.send_msg = (
                lambda to, kind, payload, _s=sent: _s.append(kind))
            client.register = lambda: None
            client._watch_stdin = lambda: threading.Event()
            client._emit = lambda msg: None
            replies = iter([
                {"kind": "finish?", "payload": {"why": "idle-gc"}},
                {"kind": "terminate"},
            ])
            client._read_line = lambda: next(replies)
            client.hold()
            if state == "idle":
                self.assertEqual(
                    sent, [], "idle hold answered instead of surfacing")
            else:
                self.assertEqual(
                    sent, ["finish-yes"],
                    "%s hold must answer finish-yes, got %r" % (state, sent),
                )

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
        # The parent-gone fork is asked first (finish-query courtesy);
        # its hold answers nothing, so the reap lands once the grace
        # on silence expires. A short grace keeps the test quick.
        stop_broker(self.root, self.proc)
        os.environ["PI_TEAMS_GC_PING_GRACE"] = "0.5"
        try:
            self.proc = start_broker(self.root, idle_timeout=15.0)
            parent = self._parent("parent-2")
            child = self._spawn_fork("fork-2", "parent-2")
            try:
                self.assertTrue(
                    wait_until(lambda: "fork-2" in self._ids(), timeout=3),
                    "fork never registered",
                )
                parent.close()
                self.assertTrue(
                    wait_until(lambda: child.poll() is not None, timeout=8),
                    "fork still alive after its parent went away",
                )
            finally:
                child.kill()
                child.wait(timeout=5)
        finally:
            os.environ.pop("PI_TEAMS_GC_PING_GRACE", None)

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