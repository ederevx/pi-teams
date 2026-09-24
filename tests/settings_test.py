"""Package settings tests: precedence, defaults, and tolerance.

PackageSettings is exercised with an injected environment and agent
directory, so no ambient variable or the real settings file can leak
into an assertion.
"""

import json
import os
import pathlib
import socket
import tempfile
import unittest

from harness import scratch_base
from peer_tunnel import PeerTunnel
from settings import PackageSettings
from team_broker import TeamBroker


class SettingsCase(unittest.TestCase):
    """A scratch agent directory plus a settings writer."""

    def setUp(self):
        self.agent = pathlib.Path(tempfile.mkdtemp(
            prefix="pi-teams-settings-", dir=scratch_base()))
        self.addCleanup(lambda: __import__("shutil").rmtree(
            self.agent, ignore_errors=True))

    def write_settings(self, payload, raw=None):
        text = raw if raw is not None else json.dumps(payload)
        (self.agent / "settings.json").write_text(text, encoding="utf-8")

    def settings(self, env=None, agent_dir=None):
        return PackageSettings(
            agent_dir=str(agent_dir or self.agent), env=env or {})


class DefaultTests(SettingsCase):
    def test_missing_file_yields_builtin_defaults(self):
        s = self.settings()
        self.assertEqual(s.host(), socket.gethostname().split(".")[0])
        self.assertEqual(
            s.state_dir(),
            os.path.join(os.path.expanduser("~"), ".local", "state",
                         "pi-teams"))
        self.assertEqual(
            s.bin_dir(), os.path.join(os.path.expanduser("~"), ".local",
                                      "bin"))
        self.assertEqual(s.sessions_root(), str(self.agent / "sessions"))
        self.assertEqual(s.fork_idle(), 300)
        self.assertEqual(s.busy_grace(), 120)
        self.assertEqual(s.gc_warn_grace(), 60)
        self.assertEqual(s.restart_grace(), 60)
        self.assertEqual(s.peer_grace(), 15)
        self.assertEqual(s.session_grace(), 3600)
        self.assertEqual(s.session_sweep_interval(), 300)
        self.assertEqual(s.spawn_window_ms(), 15000)
        self.assertEqual(s.wait_seconds(), 300)
        self.assertEqual(s.stall_seconds(), 90)
        self.assertEqual(s.ssh(), "ssh")
        self.assertIsNone(s.remote_state())
        self.assertIsNone(s.peer_setup())

    def test_xdg_state_home_shapes_the_default_root(self):
        s = self.settings({"XDG_STATE_HOME": "/xdg/state"})
        self.assertEqual(s.state_dir(), "/xdg/state/pi-teams")


class SettingsValueTests(SettingsCase):
    def test_settings_are_honored(self):
        self.write_settings({"piTeams": {
            "host": "file-host",
            "stateDir": "/file/state",
            "binDir": "/file/bin",
            "sessionsRoot": "/file/sessions",
            "forkIdleSeconds": 11,
            "busyGraceSeconds": 22,
            "gcWarnGraceSeconds": 33,
            "restartGraceSeconds": 44,
            "peerGraceSeconds": 55,
            "sessionGraceSeconds": 66,
            "sessionSweepIntervalSeconds": 77,
            "spawnWindowMs": 88,
            "waitSeconds": 99,
            "stallSeconds": 101,
            "ssh": "file-ssh",
            "remoteState": "/file/remote",
            "peerSetup": "/file/setup",
        }, "other": {"ignored": True}})
        s = self.settings()
        self.assertEqual(s.host(), "file-host")
        self.assertEqual(s.state_dir(), "/file/state")
        self.assertEqual(s.bin_dir(), "/file/bin")
        self.assertEqual(s.sessions_root(), "/file/sessions")
        self.assertEqual(s.fork_idle(), 11)
        self.assertEqual(s.busy_grace(), 22)
        self.assertEqual(s.gc_warn_grace(), 33)
        self.assertEqual(s.restart_grace(), 44)
        self.assertEqual(s.peer_grace(), 55)
        self.assertEqual(s.session_grace(), 66)
        self.assertEqual(s.session_sweep_interval(), 77)
        self.assertEqual(s.spawn_window_ms(), 88)
        self.assertEqual(s.wait_seconds(), 99)
        self.assertEqual(s.stall_seconds(), 101)
        self.assertEqual(s.ssh(), "file-ssh")
        self.assertEqual(s.remote_state(), "/file/remote")
        self.assertEqual(s.peer_setup(), "/file/setup")

    def test_env_overrides_settings(self):
        self.write_settings({"piTeams": {
            "host": "file-host", "forkIdleSeconds": 11, "ssh": "file-ssh",
        }})
        s = self.settings({
            "PI_TEAMS_HOST": "env-host",
            "PI_TEAMS_FORK_IDLE": "5",
            "PI_TEAMS_SSH": "env-ssh",
        })
        self.assertEqual(s.host(), "env-host")
        self.assertEqual(s.fork_idle(), 5)
        self.assertEqual(s.ssh(), "env-ssh")

    def test_empty_env_is_not_an_override(self):
        self.write_settings({"piTeams": {"host": "file-host"}})
        s = self.settings({"PI_TEAMS_HOST": "", "PI_TEAMS_FORK_IDLE": ""})
        self.assertEqual(s.host(), "file-host")
        self.assertEqual(s.fork_idle(), 300)

    def test_invalid_values_fall_through(self):
        self.write_settings({"piTeams": {
            "forkIdleSeconds": -1, "busyGraceSeconds": "nope",
            "host": 42, "ssh": "",
        }})
        s = self.settings({"PI_TEAMS_FORK_IDLE": "abc"})
        self.assertEqual(s.fork_idle(), 300)
        self.assertEqual(s.busy_grace(), 120)
        self.assertEqual(s.host(), socket.gethostname().split(".")[0])
        self.assertEqual(s.ssh(), "ssh")


class ToleranceTests(SettingsCase):
    def test_missing_file_is_tolerated(self):
        missing = self.agent / "no-such-agent"
        self.assertEqual(self.settings(agent_dir=missing).fork_idle(), 300)

    def test_malformed_file_is_tolerated(self):
        self.write_settings(None, raw="{not json")
        self.assertEqual(self.settings().fork_idle(), 300)

    def test_non_object_settings_are_tolerated(self):
        for payload in ([], "text", 3, None):
            self.write_settings(payload)
            self.assertEqual(self.settings().fork_idle(), 300)


class ZeroSemanticsTests(SettingsCase):
    def test_stall_zero_from_settings_and_env(self):
        self.write_settings({"piTeams": {"stallSeconds": 0}})
        self.assertEqual(self.settings().stall_seconds(), 0)
        self.assertEqual(
            self.settings({"PI_TEAMS_STALL": "0"}).stall_seconds(), 0)

    def test_gc_warn_zero_from_settings_and_env(self):
        self.write_settings({"piTeams": {"gcWarnGraceSeconds": 0}})
        self.assertEqual(self.settings().gc_warn_grace(), 0)
        self.assertEqual(
            self.settings({"PI_TEAMS_GC_WARN_GRACE": "0"}).gc_warn_grace(), 0)

    def test_gc_warn_legacy_environment_fallback(self):
        self.assertEqual(
            self.settings({"PI_TEAMS_GC_PING_GRACE": "7"}).gc_warn_grace(),
            7)
        # The current variable, when set, wins over the legacy one.
        both = self.settings({
            "PI_TEAMS_GC_WARN_GRACE": "8",
            "PI_TEAMS_GC_PING_GRACE": "7",
        })
        self.assertEqual(both.gc_warn_grace(), 8)

    def test_sessions_root_legacy_environment_fallback(self):
        self.assertEqual(
            self.settings({"PI_SESSIONS_ROOT": "/legacy"}).sessions_root(),
            "/legacy")
        both = self.settings({
            "PI_TEAMS_SESSIONS_ROOT": "/new",
            "PI_SESSIONS_ROOT": "/legacy",
        })
        self.assertEqual(both.sessions_root(), "/new")

    def test_team_root_env_and_settings(self):
        self.write_settings({"piTeams": {"stateDir": "/file/state"}})
        self.assertEqual(self.settings().state_dir(), "/file/state")
        self.assertEqual(
            self.settings({"TEAM_ROOT": "/env/root"}).state_dir(),
            "/env/root")


class BrokerWiringTests(SettingsCase):
    def test_broker_reads_settings(self):
        self.write_settings({"piTeams": {
            "host": "set-host",
            "sessionsRoot": "/set/sessions",
            "forkIdleSeconds": 11,
            "busyGraceSeconds": 22,
            "gcWarnGraceSeconds": 33,
            "restartGraceSeconds": 44,
            "peerGraceSeconds": 55,
            "sessionGraceSeconds": 66,
            "sessionSweepIntervalSeconds": 77,
        }})
        root = str(self.agent / "root")
        broker = TeamBroker(root=root, settings=self.settings())
        self.assertEqual(broker.host, "set-host")
        self.assertEqual(broker.fork_idle, 11)
        self.assertEqual(broker.busy_grace, 22)
        self.assertEqual(broker.gc_warn_grace, 33)
        self.assertEqual(broker.restart_grace, 44)
        self.assertEqual(broker.peer_grace, 55)
        self.assertEqual(broker.session_grace, 66)
        self.assertEqual(broker._session_sweep_interval, 77)
        self.assertEqual(str(broker.sessions_root), "/set/sessions")

    def test_injected_values_beat_env_and_settings(self):
        self.write_settings({"piTeams": {"forkIdleSeconds": 11}})
        s = self.settings({"PI_TEAMS_FORK_IDLE": "5"})
        broker = TeamBroker(root=str(self.agent / "root"), settings=s,
                            host="injected", fork_idle=9)
        self.assertEqual(broker.host, "injected")
        self.assertEqual(broker.fork_idle, 9.0)


class TunnelWiringTests(SettingsCase):
    def test_tunnel_reads_settings(self):
        self.write_settings({"piTeams": {
            "ssh": "file-ssh",
            "remoteState": "/file/remote",
            "peerSetup": "/file/setup",
        }})
        tunnel = PeerTunnel("peer", "user@host", settings=self.settings())
        self.assertEqual(tunnel._ssh_bin, "file-ssh")
        self.assertEqual(tunnel._remote_state, "/file/remote")
        self.assertEqual(tunnel._setup_script(), "/file/setup")

    def test_tunnel_injected_values_and_env(self):
        self.write_settings({"piTeams": {"ssh": "file-ssh"}})
        s = self.settings({"PI_TEAMS_SSH": "env-ssh"})
        injected = PeerTunnel("peer", "user@host", ssh_bin="custom",
                              remote_state="/injected", settings=s)
        self.assertEqual(injected._ssh_bin, "custom")
        self.assertEqual(injected._remote_state, "/injected")
        env = PeerTunnel("peer", "user@host", settings=s)
        self.assertEqual(env._ssh_bin, "env-ssh")


if __name__ == "__main__":
    unittest.main()
