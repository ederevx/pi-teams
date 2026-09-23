"""Member gating for message ops, enforced in the broker.

The registry trusts its clients for identity, so without this gate
any same-user process could reach the endpoint and send as, or
control, a registered agent. The gate mints one send token per
registration, returned in the register ack; every gated op must
present the token matching its asserted sender. Unauthenticated
clients keep the read-only surface (ls, ping, peer-list) and the
spawn/attach control kinds (their own request-id handshake), so raw
CLI use stays useful for diagnostics but cannot speak for an agent.
"""


class SendGate:
    """One secret per registered agent, checked on gated ops."""

    def __init__(self):
        # agent id -> send token; reached only through the API below.
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
        # The registering client presents its own secret (minted by
        # the extension, passed to hold and spawns); a re-registration
        # replaces it, so only the live client's secret is valid.
        token = str(token or "")
        if not agent_id or not token:
            return
        self._tokens[agent_id] = token

    def check(self, agent_id, token):
        # The asserted sender must hold its current credential; an
        # absent one is never a pass.
        return bool(agent_id) and agent_id in self._tokens \
            and self._tokens[agent_id] == (token or None)

    def drop(self, agent_id):
        # The agent left; its token dies with the registration.
        self._tokens.pop(agent_id, None)

    def clear(self):
        # Shutdown leaves no token state behind.
        self._tokens.clear()
