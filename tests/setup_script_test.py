#!/usr/bin/env python3
"""Tests for scripts/peer-ssh-setup.sh, the user-run one-time setup.

Only the script's pure surfaces are exercised: help, argument errors,
and --dry-run, which must print the planned commands without touching
the network or the filesystem. A missing `sh` skips the suite.
"""

import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "peer-ssh-setup.sh"
SH = shutil.which("sh")


def run_script(*args):
    return subprocess.run(
        [SH, str(SCRIPT), *args],
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


@unittest.skipUnless(SH, "no sh interpreter available")
class SetupScriptTests(unittest.TestCase):
    def test_help_prints_usage(self):
        result = run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Usage:", result.stdout)
        self.assertIn("--dry-run", result.stdout)

    def test_missing_target_is_an_error(self):
        result = run_script("--port", "843")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing user@host", result.stderr)

    def test_unknown_option_is_an_error(self):
        result = run_script("--bogus", "user@host")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown option", result.stderr)

    def test_dry_run_prints_the_plan_and_changes_nothing(self):
        result = run_script("--dry-run", "-p", "843", "user@host")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("(dry run: nothing changed)", result.stdout)
        self.assertIn("StrictHostKeyChecking=accept-new", result.stdout)
        self.assertIn("-p 843", result.stdout)
        self.assertRegex(result.stdout,
                         r"ssh-copy-id|authorized_keys")


if __name__ == "__main__":
    unittest.main()