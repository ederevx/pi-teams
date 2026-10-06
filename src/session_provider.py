"""Provider selection for the session-host capability.

The resolver binds to the best available provider — highest version,
live — and returns a SessionHostClient for it. When a descriptor exists
but no provider is live it runs the descriptor's activation entry once
and retries briefly; when still none it hands off to the injected
fallback (self-provision), which the integrator supplies. Activation is
best-effort and never a dependency: its failure falls through to the
fallback.
"""

import subprocess
import time

from service_registry import SessionHostDirectory
from session_host import SessionHostClient


def _spawn_detached(argv):
    # Activation must outlive this client: detach from its process tree.
    subprocess.Popen(argv, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)


class SessionHostResolver:
    """Chooses a live provider, activating or falling back as needed."""

    def __init__(self, fallback, directory=None, env=None, wait=0.2,
                 attempts=5, sleep=None, activation_runner=None):
        self.fallback = fallback
        self.directory = directory or SessionHostDirectory(env=env)
        self.wait = wait
        self.attempts = attempts
        self._sleep = sleep or time.sleep
        self._activation_runner = activation_runner or _spawn_detached

    def resolve(self):
        """A SessionHostClient for the best provider; activates a
        published-but-dead one, then falls back to self-provision."""
        descriptor = self._best(self.directory.live_descriptors())
        if descriptor is None:
            pending = self._best(self.directory.descriptors())
            if pending is not None and self._activate(pending):
                descriptor = self._await_live()
        if descriptor is not None:
            return SessionHostClient(descriptor)
        provisioned = self.fallback()
        if isinstance(provisioned, SessionHostClient):
            return provisioned
        if isinstance(provisioned, dict):
            return SessionHostClient(provisioned)
        descriptor = self._await_live()
        if descriptor is not None:
            return SessionHostClient(descriptor)
        raise OSError("no session-host provider")

    def _best(self, descriptors):
        if not descriptors:
            return None
        return max(descriptors, key=self._version)

    @staticmethod
    def _version(descriptor):
        version = descriptor.get("version")
        if isinstance(version, int) and not isinstance(version, bool):
            return version
        # An unknown or unparsable version sorts below every known one.
        return -1

    def _activate(self, descriptor):
        activation = descriptor.get("activation")
        if not isinstance(activation, dict) or activation.get("kind") != "exec":
            return False
        argv = activation.get("argv")
        if not (isinstance(argv, list) and argv
                and all(isinstance(a, str) for a in argv)):
            return False
        try:
            self._activation_runner(list(argv))
        except OSError:
            return False
        return True

    def _await_live(self):
        for _ in range(self.attempts):
            self._sleep(self.wait)
            descriptor = self._best(self.directory.live_descriptors())
            if descriptor is not None:
                return descriptor
        return None
