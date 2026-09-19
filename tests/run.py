#!/usr/bin/env python3
"""Run the pi-teams enforcement suite: lints then protocol tests.

Sets TMPDIR under ~/tmp/pi-teams-sandbox so test roots never touch the
system /tmp, then chains readme_lint, oop_lint, and the unittest suites
(broker protocol + fork lifecycle).
"""

import os
import pathlib
import subprocess
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

SANDBOX = os.path.join(os.path.expanduser("~"), "tmp", "pi-teams-sandbox")
os.makedirs(SANDBOX, exist_ok=True)
os.environ.setdefault("TMPDIR", SANDBOX)
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "src"))


def run_step(argv):
    return subprocess.run(argv, cwd=str(ROOT)).returncode


def main():
    steps = [
        [sys.executable, "tests/readme_lint.py"],
        [sys.executable, "tests/oop_lint.py"],
    ]
    for step in steps:
        code = run_step(step)
        if code:
            print("run: step %s failed" % step[1])
            return code

    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for module in ("broker_test", "fork_test"):
        suite.addTests(loader.loadTestsFromName(module))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())