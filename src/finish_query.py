"""Finish-query state for the broker's courtesy GC.

Before the broker reaps a work-idle fork it asks whether it is done:
the client answers at once when the teammate is busy or surfaces the
question to its agent, and the fork is spared while the answer window
is open. This module owns that state (outstanding queries, grace
expiry); the broker only records, cancels, or expires.
"""

import time


class FinishQueries:
    """Outstanding finish queries, one grace window per fork."""

    def __init__(self, grace):
        self.grace = float(grace)
        # agent id -> query time; reached only through the API below.
        self._outstanding = {}

    @property
    def enabled(self):
        # Zero disables the query and reaps immediately.
        return self.grace > 0

    def open(self, agent_id, now=None):
        # Opens the answer window.
        self._outstanding[agent_id] = self._now(now)

    def close(self, agent_id):
        # Drops a query once its answer arrived or its agent left.
        self._outstanding.pop(agent_id, None)

    def is_open(self, agent_id, now=None):
        # An open window spares the agent from this sweep cycle.
        sent_at = self._outstanding.get(agent_id)
        return sent_at is not None and self._now(now) - sent_at < self.grace

    def expired(self, now=None):
        # Closes past-grace queries, returning their ids; the next
        # sweep may query them again.
        current = self._now(now)
        expired = [
            agent_id for agent_id, sent_at in self._outstanding.items()
            if current - sent_at >= self.grace
        ]
        for agent_id in expired:
            self._outstanding.pop(agent_id, None)
        return expired

    def ids(self):
        # The ids with an outstanding query, for ownership transfer.
        return set(self._outstanding)

    def clear(self):
        # Shutdown leaves no query state behind.
        self._outstanding.clear()

    @staticmethod
    def _now(now):
        return time.time() if now is None else now
