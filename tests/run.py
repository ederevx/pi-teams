#!/usr/bin/env python3
"""Run the pi-teams enforcement suite: lints then protocol tests.

Sets TMPDIR under ~/tmp/pi-teams-sandbox so test roots never touch the
system /tmp, then chains readme_lint, oop_lint, the extension test, and
the unittest suites (broker protocol + fork lifecycle).
"""

import os
import pathlib
import shutil
import subprocess
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

SANDBOX = os.path.join(os.path.expanduser("~"), "tmp", "pi-teams-sandbox")
os.makedirs(SANDBOX, exist_ok=True)
os.environ.setdefault("TMPDIR", SANDBOX)
# Strip ambient team identity so protocol tests cannot inherit the
# environment of a pi-teams fork that runs the suite.
for _key in [k for k in os.environ if k.startswith("TEAM_")]:
    del os.environ[_key]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "src"))


def run_step(argv):
    return subprocess.run(argv, cwd=str(ROOT)).returncode


def main():
    node = shutil.which("node") or "node"
    steps = [
        [sys.executable, "tests/readme_lint.py"],
        [sys.executable, "tests/oop_lint.py"],
        [node, "--test", "--test-reporter=dot",
         "tests/extension_test.mjs"],
    ]
    for step in steps:
        code = run_step(step)
        if code:
            print("run: step %s failed" % step[1])
            return code

    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for module in ("broker_test", "fork_test", "attach_test",
                   "setup_script_test"):
        suite.addTests(loader.loadTestsFromName(module))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())