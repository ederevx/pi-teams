#!/usr/bin/env python3
"""teamd - the pi-teams broker entry point.

Composes the broker from its responsibility modules and offers the two
CLI commands: `start` runs the broker, `stop` asks the running broker to
shut down over its published endpoint. All broker logic lives in
TeamBroker; all root/path logic lives in TeamRoot.
"""

import argparse
import json
import socket
import sys

from peer_link import PeerLink
from team_broker import TeamBroker
from team_root import DEFAULT_ROOT, TEAMMATE_MARKER, TeamRoot

# Existing importers name teamd for these; keep re-exporting them so the
# entry point stays the stable surface even though ownership moved.


class BrokerCli:
    """The teamd command-line surface, separate from broker behavior."""

    @staticmethod
    def _shutdown_via_endpoint(root):
        endpoint = root.read_endpoint()
        if not endpoint:
            raise SystemExit("teamd: no endpoint at %s" % root.base)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        try:
            sock.connect((endpoint["host"], endpoint["port"]))
            sock.sendall((
                json.dumps({"op": "hello", "token": endpoint["token"]}) + "\n"
            ).encode())
            sock.sendall((json.dumps({"op": "shutdown"}) + "\n").encode())
        except OSError as exc:
            print("teamd: %s" % exc)
            raise SystemExit(1)
        finally:
            sock.close()

    def main(self, argv=None):
        parser = argparse.ArgumentParser(
            prog="teamd", description="pi-teams broker"
        )
        parser.add_argument("--root", default=DEFAULT_ROOT)
        parser.add_argument("--host", default=None)
        parser.add_argument("--idle-timeout", type=float, default=15.0)
        parser.add_argument("--fork-idle", type=float, default=None)
        parser.add_argument("--busy-grace", type=float, default=None)
        parser.add_argument("--restart-grace", type=float, default=None)
        parser.add_argument("--sweep-interval", type=float, default=1.0)
        parser.add_argument("command", nargs="?", choices=["start", "stop"],
                            default="start")
        args = parser.parse_args(argv)
        root = TeamRoot(args.root)
        if args.command == "stop":
            self._shutdown_via_endpoint(root)
            return 0
        TeamBroker(args.root, idle_timeout=args.idle_timeout,
                   sweep_interval=args.sweep_interval,
                   fork_idle=args.fork_idle, busy_grace=args.busy_grace,
                   restart_grace=args.restart_grace, host=args.host).run()
        return 0


def main(argv=None):
    return BrokerCli().main(argv)


if __name__ == "__main__":
    sys.exit(main())