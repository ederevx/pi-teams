"""Read-only discovery of published session-host providers.

A provider publishes a descriptor under a well-known local directory, so
a client enumerates providers by capability instead of hardcoding a path
or daemon name. This module owns only the directory formula and the
descriptor parse; it never writes, deletes, or mutates provider state,
and liveness reuses TeamRoot's pid probes.

Descriptor shape (unknown fields are preserved and tolerated):
    {"service": "session-host", "version": 1,
     "protocol": "pi-pty-host/1", "provider": "pi-daemon",
     "pid": 1234, "endpoint_file": "/run/.../endpoint.json",
     "activation": {"kind": "exec", "argv": [...]}}
"""

import json
import os
import pathlib
import tempfile

from team_root import TeamRoot

SERVICE = "session-host"
SERVICE_DIR = "session-host"


class SessionHostDirectory:
    """Read-only enumeration of session-host provider descriptors."""

    def __init__(self, root=None, env=None):
        self.env = dict(os.environ if env is None else env)
        self.root = pathlib.Path(root or self._default_root())
        # Only the liveness probe is borrowed; the root itself is not a
        # team root and is never created or written.
        self._team_root = TeamRoot(str(self.root))

    def _default_root(self):
        # PI_SERVICES_DIR wins, then XDG_RUNTIME_DIR, then the temp dir.
        override = self.env.get("PI_SERVICES_DIR")
        if override:
            return override
        xdg = self.env.get("XDG_RUNTIME_DIR")
        if xdg:
            return os.path.join(xdg, "pi-services")
        return os.path.join(tempfile.gettempdir(), "pi-services")

    @property
    def service_dir(self):
        return self.root / SERVICE_DIR

    def descriptors(self):
        """Every parsed session-host descriptor, live or dead; malformed
        files and other services are skipped without deleting anything."""
        found = []
        for path in self._paths():
            data = self._read(path)
            if data is not None:
                found.append(data)
        return found

    def live_descriptors(self):
        """The descriptors whose published pid is still alive."""
        return [d for d in self.descriptors() if self._is_live(d)]

    def _paths(self):
        try:
            return sorted(self.service_dir.glob("*.json"))
        except OSError:
            return []

    @staticmethod
    def _read(path):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            return None
        if not isinstance(data, dict) or data.get("service") != SERVICE:
            return None
        return data

    def _is_live(self, descriptor):
        pid = descriptor.get("pid")
        if not isinstance(pid, int) or isinstance(pid, bool):
            return False
        return self._team_root._pid_alive(pid)
