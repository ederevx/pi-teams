#!/usr/bin/env python3
"""Tests for scripts/install.sh's one-loader guard and the postinstall
manual-copy cleanup.

Each case runs the installer or the postinstall against a scratch HOME
under ~/tmp, then inspects what it wrote or removed. Scratch lives under
~/tmp, never the system /tmp. The suite skips without bash and node.
"""

import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
INSTALL = ROOT / "scripts" / "install.sh"
POSTINSTALL = ROOT / "scripts" / "postinstall.mjs"
BASH = shutil.which("bash")
NODE = shutil.which("node")
SCRATCH = os.path.expanduser("~/tmp")


class ScratchHome:
    """A disposable agent home for one installer or postinstall run."""

    def __init__(self):
        os.makedirs(SCRATCH, exist_ok=True)
        self.root = pathlib.Path(tempfile.mkdtemp(
            prefix="pi-teams-install-", dir=SCRATCH))
        self.agent = self.root / "agent"
        self.agent.mkdir()
        self.bin = self.root / "bin"
        self.state = self.root / "state"
        self.bin.mkdir()
        self.state.mkdir()

    def env(self, **extra):
        env = dict(os.environ)
        env["PI_CODING_AGENT_DIR"] = str(self.agent)
        env["PI_TEAMS_BIN_DIR"] = str(self.bin)
        env["PI_TEAMS_STATE_DIR"] = str(self.state)
        for key, value in extra.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        return env

    def settings(self, packages):
        (self.agent / "settings.json").write_text(
            json.dumps({"packages": packages}))

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


@unittest.skipUnless(BASH, "no bash interpreter available")
class InstallGuardTests(unittest.TestCase):
    def setUp(self):
        self.scratch = ScratchHome()
        self.addCleanup(self.scratch.cleanup)

    def run_install(self, **env):
        return subprocess.run(
            [BASH, str(INSTALL)], cwd=str(ROOT),
            env=self.scratch.env(**env),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_install_refuses_when_pinned(self):
        self.scratch.settings(
            ["git:github.com/ederevx/pi-teams@v0.4.19"])
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("installed as a pi package", result.stderr)
        self.assertFalse((self.scratch.agent / "extensions" / "pi-teams.ts")
                         .exists())
        self.assertFalse((self.scratch.bin / "teamd").exists())

    def test_install_refuses_a_local_path_entry(self):
        self.scratch.settings([str(ROOT)])
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("installed as a pi package", result.stderr)

    def test_install_allowed_without_a_pin(self):
        self.scratch.settings([])
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.scratch.agent / "extensions" / "pi-teams.ts")
                        .is_file())
        self.assertTrue((self.scratch.bin / "teamd").is_file())


@unittest.skipUnless(NODE, "no node interpreter available")
class PostinstallCleanupTests(unittest.TestCase):
    def setUp(self):
        self.scratch = ScratchHome()
        self.addCleanup(self.scratch.cleanup)
        # A manual install layout: byte-identical extension copies and
        # bin helpers beside a foreign file that must never be touched.
        ext = self.scratch.agent / "extensions" / "pi-teams"
        ext.mkdir(parents=True)
        shutil.copyfile(ROOT / "extensions" / "pi-teams.ts",
                        self.scratch.agent / "extensions" / "pi-teams.ts")
        for source in (ROOT / "extensions" / "pi-teams").glob("*.ts"):
            shutil.copyfile(source, ext / source.name)
        shutil.copyfile(ROOT / "src" / "teamd.py", self.scratch.bin / "teamd")
        (ext / "foreign.ts").write_text("// not ours\n")
        (self.scratch.agent / "extensions" / "keepme.ts").write_text(
            "// not ours\n")
        self.scratch.settings(["git:github.com/ederevx/pi-teams@v0.4.19"])

    def run_postinstall(self):
        return subprocess.run(
            [NODE, str(POSTINSTALL)], cwd=str(ROOT),
            env=self.scratch.env(), capture_output=True, text=True)

    def test_postinstall_drops_manual_copies_and_keeps_foreign_files(self):
        result = self.run_postinstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("removed manual-install copies", result.stderr)
        self.assertFalse((self.scratch.agent / "extensions" / "pi-teams.ts")
                         .exists())
        self.assertFalse((self.scratch.bin / "teamd").exists())
        self.assertTrue((self.scratch.agent / "extensions" / "keepme.ts")
                        .exists())
        # The module dir holds a foreign file and no manifest owns it,
        # so only its byte-identical members go and the dir stays.
        self.assertTrue((self.scratch.agent / "extensions" / "pi-teams"
                         / "foreign.ts").exists())

    def test_postinstall_keeps_a_modified_dir_without_a_manifest(self):
        # No manifest: the dir holds a locally modified module, so the
        # byte-identical rule keeps it; only the identical entry file goes.
        module = self.scratch.agent / "extensions" / "pi-teams"
        (module / "agent.ts").write_text("// locally modified\n")
        result = self.run_postinstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.scratch.agent / "extensions" / "pi-teams.ts")
                         .exists())
        self.assertTrue((module / "agent.ts").exists())

    def test_postinstall_drops_manifest_owned_bin_files(self):
        manifest = {
            "bin_dir": str(self.scratch.bin),
            "agent_dir": str(self.scratch.agent),
            "files": [str(self.scratch.bin / "teamd")],
        }
        (self.scratch.state / "manifest.json").write_text(
            json.dumps(manifest))
        result = self.run_postinstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.scratch.bin / "teamd").exists())


if __name__ == "__main__":
    unittest.main()