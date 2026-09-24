"""Package settings for pi-teams.

Owns the `piTeams` namespace of pi's agent-directory
`settings.json`: a guarded read and typed accessors, so every
configurable flag has one source of truth. Precedence for every value
is an explicit non-empty environment variable, then the settings value
when present and valid, then the built-in default. Nothing about the
broker, the client, or the protocol belongs here.
"""

import json
import math
import os
import pathlib
import socket


class PackageSettings:
    """Loads and resolves the `piTeams` settings namespace."""

    def __init__(self, agent_dir=None, env=None):
        self._env = os.environ if env is None else env
        self._agent_dir = pathlib.Path(
            agent_dir or self._env.get("PI_CODING_AGENT_DIR")
            or os.path.join(os.path.expanduser("~"), ".pi", "agent"))
        self._namespace = None

    # -- loading -----------------------------------------------------

    def _load(self):
        # A missing, unreadable, malformed, or non-object settings file
        # is tolerated as "no settings", never as a failure.
        if self._namespace is not None:
            return self._namespace
        self._namespace = {}
        data = self._guard_load()
        namespace = data.get("piTeams")
        if isinstance(namespace, dict):
            self._namespace = namespace
        return self._namespace

    def _guard_load(self):
        try:
            data = json.loads(
                (self._agent_dir / "settings.json").read_text(
                    encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    # -- resolution --------------------------------------------------

    def resolve(self, env_name, key, default, kind):
        """The value for one setting: env (one name or several, in
        priority order), then the settings key when present and valid,
        then `default`."""
        names = (env_name,) if isinstance(env_name, str) else env_name
        for name in names:
            raw = self._env.get(name)
            if raw is None or raw == "":
                continue
            value = self._coerce(raw, kind)
            if value is not None:
                return value
        raw = self._load().get(key)
        if raw is not None:
            value = self._coerce(raw, kind)
            if value is not None:
                return value
        return default

    @staticmethod
    def _coerce(raw, kind):
        # A number is a finite value at or above zero, so 0 is a real
        # value (immediate reap, disabled warning) rather than unset.
        if kind == "number":
            if isinstance(raw, bool):
                return None
            try:
                value = float(raw)
            except (TypeError, ValueError):
                return None
            if math.isfinite(value) and value >= 0:
                return value
            return None
        if kind == "bool":
            if isinstance(raw, bool):
                return raw
            text = str(raw).strip().lower()
            if text in ("1", "true", "yes", "on"):
                return True
            if text in ("0", "false", "no", "off"):
                return False
            return None
        if not isinstance(raw, str) or raw == "":
            return None
        if kind == "path":
            return os.path.expanduser(raw)
        return raw

    # -- typed accessors ---------------------------------------------

    def host(self):
        return self.resolve("PI_TEAMS_HOST", "host", None, "text") \
            or socket.gethostname().split(".")[0]

    def state_dir(self):
        return self.resolve("TEAM_ROOT", "stateDir", None, "path") \
            or os.path.join(
                self._env.get("XDG_STATE_HOME")
                or os.path.join(os.path.expanduser("~"), ".local", "state"),
                "pi-teams")

    def sessions_root(self):
        # PI_SESSIONS_ROOT stays a legacy fallback for the extension's
        # old variable name.
        return self.resolve(
            ("PI_TEAMS_SESSIONS_ROOT", "PI_SESSIONS_ROOT"),
            "sessionsRoot", None, "path") \
            or os.path.join(str(self._agent_dir), "sessions")

    # Reaper windows are configured in hours: every GC setting key ends
    # in "Hours" and its value counts hours. The broker's clocks are all
    # seconds, so these accessors convert once, here. Zero keeps its
    # meaning (immediate reap or disabled warning) after conversion.
    def fork_idle(self):
        return self.resolve(
            "PI_TEAMS_FORK_IDLE_HOURS", "forkIdleHours", 6,
            "number") * 3600.0

    def busy_grace(self):
        return self.resolve(
            "PI_TEAMS_BUSY_GRACE_HOURS", "busyGraceHours", 2,
            "number") * 3600.0

    def gc_warn_grace(self):
        return self.resolve(
            "PI_TEAMS_GC_WARN_HOURS", "gcWarnGraceHours", 1,
            "number") * 3600.0

    def restart_grace(self):
        return self.resolve(
            "PI_TEAMS_RESTART_GRACE", "restartGraceSeconds", 60, "number")

    def peer_grace(self):
        return self.resolve(
            "PI_TEAMS_PEER_GRACE", "peerGraceSeconds", 15, "number")

    def session_grace(self):
        return self.resolve(
            "PI_TEAMS_SESSION_GRACE_HOURS", "sessionGraceHours", 72,
            "number") * 3600.0

    def session_sweep_interval(self):
        return self.resolve(
            "PI_TEAMS_SESSION_SWEEP_INTERVAL",
            "sessionSweepIntervalSeconds", 3600, "number")

    def ssh(self):
        return self.resolve("PI_TEAMS_SSH", "ssh", "ssh", "text")

    def remote_state(self):
        return self.resolve(
            "PI_TEAMS_REMOTE_STATE", "remoteState", None, "text")

    def peer_setup(self):
        return self.resolve(
            "PI_TEAMS_PEER_SETUP", "peerSetup", None, "text")
