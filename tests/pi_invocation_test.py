"""PiInvocation tests: the launch a Python daemon resolves for pi."""

import os
import sys
import tempfile
import unittest

import harness  # noqa: F401 - inserts src/ on sys.path
from pi_invocation import PiInvocation


def _entry(name):
    """A real file the resolver will accept as the pi entry."""
    handle, path = tempfile.mkstemp(suffix=name)
    os.close(handle)
    return path


class PiInvocationTest(unittest.TestCase):

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

    def test_a_missing_entry_falls_through_to_the_command(self):
        env = {"PI_TEAMS_PI_ENTRY": os.path.join(tempfile.gettempdir(),
                                                "absent-pi-entry.js"),
               "PI_TEAMS_PI_COMMAND": "node"}
        self.assertEqual(PiInvocation.resolve(environ=env), ("node", []))


if __name__ == "__main__":
    unittest.main()
