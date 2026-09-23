"""Park-and-forward decision layer between the broker and the mailbox.

One owner for the delivery semantics the broker needs: which
connection-less local targets still belong to the team (a recent
drop, not an eviction), when to park instead of failing, and how
parked messages replay onto a re-registered connection. The Mailbox
store owns the files; this class owns drop bookkeeping and replay
order.
"""

import time


class MailboxDelivery:
    """Owns parked-message acceptance, replay, and expiry for one root."""

    def __init__(self, store):
        self.store = store
        # agent_id -> last connection loss (a drop is not an eviction:
        # sends during the hold-restart gap park).
        self._dropped_at = {}

    def mark_dropped(self, agent_id):
        self._dropped_at[agent_id] = time.time()

    def accepts(self, agent_id, registered):
        # True when a send to a connection-less local target should
        # park: the target is still registered without a live conn, or
        # its connection dropped within the mailbox ttl.
        grace = self.store.ttl
        dropped = self._dropped_at.get(agent_id)
        if registered:
            return True
        return dropped is not None and time.time() - dropped <= grace

    def park(self, agent_id, envelope):
        return self.store.enqueue(agent_id, envelope)

    def replay(self, agent_id, write):
        # Write every parked envelope to the reconnected target, then
        # drop the delivered ones: a crash in between costs a
        # redelivery the client filters by id, never a loss; a failed
        # write stays parked for the next register.
        delivered = []
        for record in self.store.parked(agent_id):
            msg_id = str(record.get("id") or "")
            envelope = {
                "op": "message",
                "from": record.get("from") or "*",
                "to": record.get("to") or agent_id,
                "kind": str(record.get("kind") or "text"),
                "payload": record.get("payload"),
                "ts": record.get("ts") or time.time(),
            }
            if msg_id:
                envelope["id"] = msg_id
            if write(envelope):
                delivered.append(msg_id)
        for msg_id in delivered:
            if msg_id:
                self.store.drop(agent_id, msg_id)
        return delivered

    def prune(self, now):
        # Drop expired parked messages and forget old connection-drop
        # marks so both maps cannot grow without bound.
        self.store.prune(now)
        grace = self.store.ttl
        self._dropped_at = {
            agent_id: dropped
            for agent_id, dropped in self._dropped_at.items()
            if now - dropped <= grace
        }