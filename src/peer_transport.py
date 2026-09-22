"""Broker-owned ssh transport for peer links.

One owner for the ssh-tunnel side of peer federation: which tunnel
serves which label, which tunnel owns a host's link, the durable
label -> ssh config, and the add/remove/list/restore operations over
them. The broker composes this owner and keeps the link-level logic
(which peer serves a host, remote views, relay accounting) to itself;
PeerTunnel still owns a single tunnel's transport details.
"""

from peer_tunnel import PeerTunnel, PeerUnreachable


class PeerTransport:
    """The ssh tunnels, their durable config, and their link ownership."""

    def __init__(self, host, tunnel_factory=None):
        self.host = host
        self._tunnel_factory = tunnel_factory or PeerTunnel
        # A live tunnel per label, the durable label -> ssh config, and
        # which tunnel opened each host's outbound link.
        self._tunnels = {}
        self._peer_config = {}
        self._peer_owner = {}

    def tunnel_for(self, target_host):
        for tunnel in self._tunnels.values():
            if tunnel.host == target_host:
                return tunnel
        return None

    def forget_tunnel(self, tunnel):
        # ssh exited on its own. Forget the tunnel but keep the durable
        # config so the next broker start can restore it; returns the
        # host when this tunnel still owned its link, so the caller can
        # drop that link.
        if self._tunnels.get(tunnel.label) is tunnel:
            self._tunnels.pop(tunnel.label, None)
        owns = bool(tunnel.host) \
            and self._peer_owner.get(tunnel.host) is tunnel
        if owns:
            self._peer_owner.pop(tunnel.host, None)
        return tunnel.host if owns else None

    def owns_link(self, target_host, tunnel):
        return self._peer_owner.get(target_host) is tunnel

    def link_owned(self, target_host):
        # Whether any tunnel currently owns the host's outbound link.
        return self._peer_owner.get(target_host) is not None

    def clear_owner(self, target_host, tunnel=None):
        # Drops the ownership entry for a host; with a tunnel given, only
        # that tunnel's ownership is dropped.
        if tunnel is None:
            self._peer_owner.pop(target_host, None)
        elif self._peer_owner.get(target_host) is tunnel:
            self._peer_owner.pop(target_host, None)

    def config(self, label):
        return self._peer_config.get(label)

    def set_config(self, label, ssh, target_host=None):
        self._peer_config[label] = {
            "ssh": ssh, "host": target_host or label,
        }

    def drop_config(self, label):
        self._peer_config.pop(label, None)

    def add(self, label, ssh, on_exit, link_state, try_link):
        """Own the ssh tunnel to a peer and link it. Replaces any tunnel
        or link already serving the same label or host. `link_state(host)`
        returns (existing link or None, whether our tunnel owns it);
        `try_link(host, endpoint)` opens the broker link and returns
        whether it was accepted. Returns (host, endpoint)."""
        label = label or ssh
        if not label or not ssh:
            raise PeerUnreachable(
                ssh, "label and ssh target are required", "")
        old = self._tunnels.pop(label, None)
        if old is not None:
            self.clear_owner(old.host, old)
            old.close()
        self.drop_config(label)
        tunnel = self._tunnel_factory(label, ssh, on_exit=on_exit)
        endpoint = tunnel.start()
        target_host = tunnel.host or label
        existing, owns_link = link_state(target_host)
        if (existing is not None and existing.connected and not owns_link
                and self.host > target_host):
            # A connected inbound link already serves this host, and this
            # host is the larger label, so the smaller host owns the
            # outbound direction. Keep the working link and spend the new
            # tunnel instead of tearing down the pair.
            tunnel.close()
            self.set_config(label, ssh, target_host)
            self.persist()
            return target_host, existing.endpoint
        # One host has one live link; a tunnel under another label for
        # the same host is released before the new one takes ownership.
        other = self.tunnel_for(target_host)
        if other is not None and other is not tunnel:
            self._tunnels.pop(other.label, None)
            self._peer_config.pop(other.label, None)
            self._peer_owner.pop(target_host, None)
            other.close()
        if not try_link(target_host, endpoint):
            tunnel.close()
            raise PeerUnreachable(
                ssh, "the peer endpoint did not accept the link",
                tunnel.setup_command())
        self._tunnels[label] = tunnel
        self._peer_owner[target_host] = tunnel
        self.set_config(label, ssh, target_host)
        self.persist()
        return target_host, endpoint

    def remove(self, label):
        """Close a peer's tunnel and return its host so the caller drops
        the link; None when no tunnel served the label."""
        tunnel = self._tunnels.pop(label, None)
        self._peer_config.pop(label, None)
        if tunnel is None:
            return None
        target_host = tunnel.host
        self.clear_owner(target_host, tunnel)
        tunnel.close()
        return target_host

    def list(self, connected):
        """The peer list: durable config joined with each link's online
        state. `connected(host)` reports whether a live link serves it."""
        peers = []
        for label in sorted(self._peer_config):
            meta = self._peer_config[label]
            target_host = meta.get("host") or label
            peers.append({
                "label": label,
                "host": target_host,
                "online": bool(connected(target_host)),
                "ssh": meta.get("ssh") or "",
            })
        return peers

    def load(self, read_peers, try_restore):
        """Restores the durable config from a previous run: a stored peer
        is re-added through `try_restore(label, ssh)`; a host that is
        down keeps its config for the next start to retry."""
        for label, meta in read_peers().items():
            if not isinstance(meta, dict):
                continue
            ssh = meta.get("ssh")
            if not ssh:
                continue
            try:
                try_restore(label, ssh)
            except PeerUnreachable:
                self.set_config(label, ssh, meta.get("host") or label)
        self.persist()

    def snapshot_config(self):
        return {label: dict(meta) for label, meta in self._peer_config.items()}

    def persist(self):
        # Hook the broker fills in; a config change is written through
        # the root's atomic writer.
        pass

    def close_all(self):
        tunnels = list(self._tunnels.values())
        self._tunnels.clear()
        self._peer_owner.clear()
        for tunnel in tunnels:
            tunnel.close()
