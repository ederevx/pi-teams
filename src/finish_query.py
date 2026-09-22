"""Finish-query state for the broker's courtesy GC.

Before the broker reaps a work-idle fork it asks whether it is done: a
query goes to the fork's client, the client answers at once when the
teammate is busy or surfaces the question to its agent, and the fork is
spared while its answer window is open. This module owns that state -
which queries are outstanding and when their grace expires - so the
broker only asks it to record, cancel, or expire a query.
"""

import time


class FinishQueries:
    """Outstanding finish queries, one grace window per fork."""

    def __init__(self, grace):
        self.grace = float(grace)
        # agent id -> time the query was sent. Owned here; the broker
        # never reaches into the map, only through the methods below.
        self._outstanding = {}

    @property
    def enabled(self):
        # Zero disables the query entirely and reaps immediately, as
        # earlier versions did.
        return self.grace > 0

    def open(self, agent_id, now=None):
        # Records a query as sent now, opening its answer window.
        self._outstanding[agent_id] = time.time() if now is None else now

    def close(self, agent_id):
        # Drops a query once its answer arrived or its agent left.
        self._outstanding.pop(agent_id, None)

    def is_open(self, agent_id, now=None):
        # Whether an answer window is still open for this agent, so the
        # sweep must spare it for this cycle.
        sent_at = self._outstanding.get(agent_id)
        if sent_at is None:
            return False
        current = time.time() if now is None else now
        return current - sent_at < self.grace

    def expired(self, now=None):
        # Closes every query past its grace, returning the ids whose
        # windows just closed; the next sweep may query them again.
        current = time.time() if now is None else now
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
