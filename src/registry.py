"""The on-disk registry mirror and its freshness semantics.

One owner for the registry's two derived views: the live snapshot with
its computed online flag, and the cadence-written registry.json file
that outside readers consult. The broker owns the registry dict and
its lock; this class renders from it and never mutates entries.
"""

import json
import time

from team_root import REGISTRY_NAME

# Heartbeats refresh the mirror at most this often, so readers of the
# file never see a snapshot frozen at the last registry event.
MIRROR_CADENCE = 10.0


class RegistryMirror:
    """Owns the registry file writes and the online computation."""

    def __init__(self, root, registry, idle_timeout):
        self.root = root
        self.registry = registry
        self.idle_timeout = idle_timeout
        self._last_write = 0.0

    def snapshot(self, now):
        # online is computed, never stored: an entry only counts as
        # online while a heartbeat arrived within the same liveness
        # window the sweep uses, so a stalled client never reads online.
        return [
            dict(
                entry,
                online=now - entry.get("last_seen", 0) <= self.idle_timeout,
            )
            for entry in self.registry.values()
        ]

    def render(self, now):
        return json.dumps(
            {"ts": now, "agents": self.registry}, indent=2)

    def due(self, now):
        # True once per cadence window; the caller writes.
        if now - self._last_write < MIRROR_CADENCE:
            return False
        self._last_write = now
        return True
