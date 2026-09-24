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


def ensure_pi_modules():
    """Symlink the pi TUI packages into the repo's gitignored
    node_modules so the extension tests can resolve the settings view's
    imports, mirroring the sibling repositories. Derived from the global
    pi install; a no-op when the links already resolve."""
    node = shutil.which("node")
    if not node:
        return
    agent = (pathlib.Path(node).resolve().parent.parent / "lib"
             / "node_modules" / "@earendil-works" / "pi-coding-agent")
    if not agent.exists():
        return
    nested = agent / "node_modules" / "@earendil-works"
    target = ROOT / "node_modules" / "@earendil-works"
    try:
        target.mkdir(parents=True, exist_ok=True)
        for name, dest in (("pi-coding-agent", agent),
                           ("pi-tui", nested / "pi-tui"),
                           ("pi-ai", nested / "pi-ai"),
                           ("typebox", agent / "node_modules" / "typebox")):
            link = target / name
            if not link.exists() and dest.exists():
                link.symlink_to(dest)
    except OSError:
        # Symlinks need privileges on Windows; the run still proceeds.
        pass


def run_step(argv):
    return subprocess.run(argv, cwd=str(ROOT)).returncode


def main():
    ensure_pi_modules()
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
                   "settings_test", "setup_script_test", "install_test"):
        suite.addTests(loader.loadTestsFromName(module))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())