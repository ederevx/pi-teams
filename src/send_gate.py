"""Member gating for message ops, enforced in the broker.

The registry trusts its clients for identity, so without this gate any
same-user process could reach the loopback endpoint and send as, or
control, a registered agent - bypassing the extension's member-only
tooling. The gate mints one send token per registration and hands it
back in the register ack; every gated op must present the token that
matches its asserted sender. Unauthenticated clients keep the
read-only surface (ls, ping, peer-list) and the spawn/attach control
kinds, which carry their own request-id handshake, so raw CLI use
stays useful for diagnostics but cannot speak for an agent.
"""


class SendGate:
    """One secret per registered agent, checked on gated ops."""

    def __init__(self):
        # agent id -> send token. Owned here; the broker reaches it
        # only through issue, check, and drop.
        self._tokens = {}

    @staticmethod
    def refused_reason():
        # One wording for every refusal, so clients and docs quote it.
        return (
            "send-token required for this op; agents use pi-teams "
            "tools (team_send/team_spawn/...), holds present "
            "TEAM_SEND_TOKEN, diagnostics use team ls/peer list"
        )

    def issue(self, agent_id, token):
        # The registering client presents its own secret (the
        # extension mints one per session and passes it to the hold it
        # launches and to the teammates it spawns). A re-registration
        # (a fresh hold) replaces the old token, so exactly the live
        # client's secret is valid at any time.
        token = str(token or "")
        if not agent_id or not token:
            return
        self._tokens[agent_id] = token

    def check(self, agent_id, token):
        # Whether this asserted sender may act: the agent must be
        # registered WITH a credential and the presented token must be
        # its current one. An absent credential is never a pass.
        return bool(agent_id) and agent_id in self._tokens \
            and self._tokens[agent_id] == (token or None)

    def drop(self, agent_id):
        # The agent left; its token dies with the registration.
        self._tokens.pop(agent_id, None)

    def clear(self):
        # Shutdown leaves no token state behind.
        self._tokens.clear()
