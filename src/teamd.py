#!/usr/bin/env python3
"""teamd - the pi-teams broker entry point.

Composes the broker from its responsibility modules and offers two CLI
commands: `start` runs the broker, `stop` asks the running one to shut
down over its endpoint. Broker logic lives in TeamBroker, root/path
logic in TeamRoot.
"""

import argparse
import json
import os
import socket
import sys

from peer_link import PeerLink
from pi_invocation import PiInvocation
from team_broker import TeamBroker
from team_root import DEFAULT_ROOT, TEAMMATE_MARKER, TeamRoot
from wire import LineStream, dump_line

# Existing importers name teamd for these; keep re-exporting them so the
# entry point stays the stable surface even though ownership moved.


class BrokerCli:
    """The teamd command-line surface, separate from broker behavior."""

    TIMEOUT = 2.0

    @staticmethod
    def _read_reply(sock, stream):
        """One JSON reply from the broker, or None at a clean EOF."""
        while True:
            line = stream.next_line()
            if line is None:
                chunk = sock.recv(65536)
                if not chunk:
                    return None
                stream.push(chunk)
                continue
            if not line.strip():
                continue
            try:
                return json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                raise OSError("malformed broker reply")

    @classmethod
    def _shutdown_via_endpoint(cls, root):
        endpoint = root.read_endpoint()
        if not endpoint:
            raise SystemExit("teamd: no endpoint at %s" % root.base)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(cls.TIMEOUT)
        stream = LineStream()
        try:
            sock.connect((endpoint["host"], endpoint["port"]))
            sock.sendall(dump_line(
                {"op": "hello", "token": endpoint["token"]}))
            # Read the handshake reply before sending shutdown: closing
            # with the ack still unread discards queued data (a TCP RST
            # on Windows), and `shutdown` would be dropped on the floor.
            reply = cls._read_reply(sock, stream)
            if not reply or reply.get("op") != "ack":
                raise OSError("broker handshake rejected: %r" % (reply,))
            sock.sendall(dump_line({"op": "shutdown"}))
            reply = cls._read_reply(sock, stream)
            if not reply or reply.get("op") != "ack":
                raise OSError(
                    "broker did not acknowledge shutdown: %r" % (reply,))
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
        parser.add_argument("--gc-idle", type=float, default=None)
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
        # A broker that inherited the launch entry refreshes the durable
        # record, repairing a lost extension write; a broker started by
        # an older extension has nothing to persist and leaves the file.
        PiInvocation.persist(root, os.environ)
        TeamBroker(args.root, idle_timeout=args.idle_timeout,
                   sweep_interval=args.sweep_interval,
                   gc_idle=args.gc_idle, busy_grace=args.busy_grace,
                   restart_grace=args.restart_grace, host=args.host).run()
        return 0


def main(argv=None):
    return BrokerCli().main(argv)


if __name__ == "__main__":
    sys.exit(main())