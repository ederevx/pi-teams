"""PiInvocation tests: the launch a Python daemon resolves for pi."""

import json
import os
import shutil
import sys
import tempfile
import unittest

import harness  # noqa: F401 - inserts src/ on sys.path
from pi_invocation import PiInvocation
from team_root import TeamRoot

ENTRY_NAME = "pi-entry.json"


def _entry(name):
    """A real file the resolver will accept as the pi entry."""
    handle, path = tempfile.mkstemp(suffix=name)
    os.close(handle)
    return path


class PiInvocationTest(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="pi-invocation-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def _record_path(self):
        return os.path.join(self.root, ENTRY_NAME)

    def _write_record(self, record):
        with open(self._record_path(), "w", encoding="utf-8") as handle:
            handle.write(json.dumps(record))

    def _symlinked_js_entry(self):
        """A suffixless launcher symlink to a real .js file, as npm
        installs it (`node_modules/.bin/pi`)."""
        target = _entry(".js")
        self.addCleanup(os.unlink, target)
        link = os.path.join(self.root, "pi")
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not available")
        return link

    def _read_record(self):
        with open(self._record_path(), "r", encoding="utf-8") as handle:
            return handle.read()

    # -- environment precedence (unchanged) --------------------------

    def test_unconfigured_resolves_the_bare_name(self):
        self.assertEqual(PiInvocation.resolve(environ={}), ("pi", []))

    def test_a_configured_command_carries_its_args(self):
        env = {"PI_TEAMS_PI_COMMAND": "node",
               "PI_TEAMS_PI_ARGS": "cli.js --flag"}
        self.assertEqual(PiInvocation.resolve(environ=env),
                         ("node", ["cli.js", "--flag"]))

    def test_a_js_entry_runs_under_the_configured_runtime(self):
        entry = _entry(".js")
        self.addCleanup(os.unlink, entry)
        env = {"PI_TEAMS_PI_ENTRY": entry,
               "PI_TEAMS_PI_NODE": os.path.join("C:", "node", "node.exe")}
        self.assertEqual(PiInvocation.resolve(environ=env),
                         (env["PI_TEAMS_PI_NODE"], [entry]))

    def test_a_non_js_entry_runs_under_this_interpreter(self):
        entry = _entry(".py")
        self.addCleanup(os.unlink, entry)
        self.assertEqual(
            PiInvocation.resolve(environ={"PI_TEAMS_PI_ENTRY": entry}),
            (sys.executable, [entry]))

    def test_a_symlinked_js_entry_runs_under_the_named_runtime(self):
        link = self._symlinked_js_entry()
        env = {"PI_TEAMS_PI_ENTRY": link, "PI_TEAMS_PI_NODE": "node"}
        self.assertEqual(PiInvocation.resolve(environ=env),
                         ("node", [link]))

    def test_a_suffixless_js_entry_is_detected_by_its_target(self):
        link = self._symlinked_js_entry()
        runtime, args = PiInvocation.resolve(
            environ={"PI_TEAMS_PI_ENTRY": link})
        self.assertNotEqual(runtime, sys.executable)
        self.assertEqual(args, [link])

    def test_a_missing_entry_falls_through_to_the_command(self):
        env = {"PI_TEAMS_PI_ENTRY": os.path.join(tempfile.gettempdir(),
                                                "absent-pi-entry.js"),
               "PI_TEAMS_PI_COMMAND": "node"}
        self.assertEqual(PiInvocation.resolve(environ=env), ("node", []))

    # -- persisted launch record -------------------------------------

    def test_a_persisted_entry_resolves_without_the_env(self):
        entry = _entry(".js")
        self.addCleanup(os.unlink, entry)
        self._write_record({"version": 1, "entry": entry,
                            "node": "C:/node/node.exe"})
        self.assertEqual(PiInvocation.resolve(environ={}, root=self.root),
                         ("C:/node/node.exe", [entry]))

    def test_a_persisted_suffixless_entry_runs_under_its_node(self):
        link = self._symlinked_js_entry()
        self._write_record({"version": 1, "entry": link, "node": "node"})
        self.assertEqual(PiInvocation.resolve(environ={}, root=self.root),
                         ("node", [link]))

    def test_a_persisted_command_resolves_without_the_env(self):
        self._write_record({"version": 1, "command": "/opt/pi/bin",
                            "args": ["--x"]})
        self.assertEqual(PiInvocation.resolve(environ={}, root=self.root),
                         ("/opt/pi/bin", ["--x"]))

    def test_an_unknown_version_and_fields_are_ignored(self):
        entry = _entry(".js")
        self.addCleanup(os.unlink, entry)
        self._write_record({"version": 99, "entry": entry,
                            "node": "node", "future": {"a": 1}})
        self.assertEqual(PiInvocation.resolve(environ={}, root=self.root),
                         ("node", [entry]))

    def test_the_env_beats_the_persisted_record(self):
        persisted = _entry(".js")
        self.addCleanup(os.unlink, persisted)
        live = _entry(".js")
        self.addCleanup(os.unlink, live)
        self._write_record({"version": 1, "entry": persisted, "node": "old"})
        env = {"PI_TEAMS_PI_ENTRY": live, "PI_TEAMS_PI_NODE": "new"}
        self.assertEqual(PiInvocation.resolve(environ=env, root=self.root),
                         ("new", [live]))

    def test_an_absent_record_falls_back_to_bare(self):
        self.assertEqual(PiInvocation.resolve(environ={}, root=self.root),
                         ("pi", []))

    def test_a_malformed_record_falls_back_to_bare(self):
        with open(self._record_path(), "w", encoding="utf-8") as handle:
            handle.write("{not json")
        self.assertEqual(PiInvocation.resolve(environ={}, root=self.root),
                         ("pi", []))

    def test_a_record_naming_no_live_entry_falls_back_to_bare(self):
        self._write_record({"version": 1,
                            "entry": os.path.join(self.root, "gone.js")})
        self.assertEqual(PiInvocation.resolve(environ={}, root=self.root),
                         ("pi", []))

    def test_a_persisted_bare_name_is_not_used(self):
        self._write_record({"version": 1, "command": "pi"})
        self.assertEqual(PiInvocation.resolve(environ={}, root=self.root),
                         ("pi", []))

    # -- persist guard -----------------------------------------------

    def test_persist_writes_a_record_and_reads_it_back(self):
        entry = _entry(".js")
        self.addCleanup(os.unlink, entry)
        env = {"PI_TEAMS_PI_ENTRY": entry, "PI_TEAMS_PI_NODE": "node"}
        self.assertTrue(PiInvocation.persist(TeamRoot(self.root), env))
        self.assertEqual(PiInvocation.resolve(environ={}, root=self.root),
                         ("node", [entry]))

    def test_a_bare_fallback_does_not_overwrite_the_record(self):
        entry = _entry(".js")
        self.addCleanup(os.unlink, entry)
        root = TeamRoot(self.root)
        env = {"PI_TEAMS_PI_ENTRY": entry, "PI_TEAMS_PI_NODE": "node"}
        self.assertTrue(PiInvocation.persist(root, env))
        kept = self._read_record()
        self.assertFalse(PiInvocation.persist(root, environ={}))
        self.assertEqual(self._read_record(), kept)

    def test_persist_needs_a_root_that_can_write(self):
        env = {"PI_TEAMS_PI_COMMAND": "node"}
        self.assertFalse(PiInvocation.persist(self.root, env))


if __name__ == "__main__":
    unittest.main()
