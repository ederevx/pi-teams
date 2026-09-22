#!/usr/bin/env python3
"""team - the pi-teams client entry point.

Composes the client from TeamClient and exposes the CLI: register, ls,
send, follow, hold, terminate, deregister, and peer add/remove.
Teammates are spawned only by the extension's structured team_spawn
tool, never by an arbitrary client command. The CLI takes no routing
logic of its own; it only parses arguments and drives TeamClient.
"""

import argparse
import json
import sys

from team_client import TeamClient
from team_root import DEFAULT_ROOT

# Existing importers name team for the client class; keep re-exporting it.


class ClientCli:
    """The team command-line surface, separate from client behavior."""

    @staticmethod
    def parse_payload(text):
        try:
            return json.loads(text)
        except ValueError:
            return text

    @staticmethod
    def add_identity_args(parser):
        parser.add_argument("--id")
        parser.add_argument("--name")
        parser.add_argument("--role")
        parser.add_argument("--parent")
        parser.add_argument("--session")
        parser.add_argument("--owner-pid")
        parser.add_argument("--busy-file")
        parser.add_argument("--attached", action="store_true")

    @staticmethod
    def apply_identity(client, args):
        client.set_identity(args.id, args.name, args.role, args.parent,
                            args.session, args.owner_pid, args.busy_file,
                            getattr(args, "attached", None))

    def main(self, argv=None):
        parser = argparse.ArgumentParser(
            prog="team", description="pi-teams client"
        )
        parser.add_argument("--root", default=DEFAULT_ROOT)
        sub = parser.add_subparsers(dest="command")

        p_register = sub.add_parser("register")
        self.add_identity_args(p_register)
        sub.add_parser("ls")
        sub.add_parser("deregister")
        p_follow = sub.add_parser("follow")
        self.add_identity_args(p_follow)
        p_hold = sub.add_parser("hold")
        self.add_identity_args(p_hold)
        p_send = sub.add_parser("send")
        self.add_identity_args(p_send)
        p_send.add_argument("to")
        p_send.add_argument("kind", nargs="?", default="text")
        p_send.add_argument("payload", nargs="?", default="")
        p_term = sub.add_parser("terminate")
        p_term.add_argument("to")
        p_term.add_argument("why", nargs="?", default="requested")
        p_peer = sub.add_parser("peer")
        peer_sub = p_peer.add_subparsers(dest="action")
        p_peer_add = peer_sub.add_parser("add")
        p_peer_add.add_argument("--label")
        p_peer_add.add_argument("--ssh", required=True)
        p_peer_rm = peer_sub.add_parser("remove")
        p_peer_rm.add_argument("label")
        peer_sub.add_parser("list")

        args = parser.parse_args(argv)
        if args.command is None:
            parser.print_help()
            return 0
        client = TeamClient(args.root)
        if args.command in ("register", "follow", "hold", "send"):
            self.apply_identity(client, args)
        if args.command == "register":
            print(json.dumps(client.register()))
        elif args.command == "ls":
            print(json.dumps(client.ls(), indent=2))
        elif args.command == "deregister":
            print(json.dumps(client.deregister()))
        elif args.command == "follow":
            client.follow()
        elif args.command == "hold":
            client.hold()
        elif args.command == "send":
            print(json.dumps(client.send_msg(
                args.to, args.kind, self.parse_payload(args.payload)
            )))
        elif args.command == "terminate":
            print(json.dumps(client.terminate(args.to, args.why)))
        elif args.command == "peer":
            if args.action == "add":
                label = args.label or args.ssh
                print(json.dumps(client.peer_add(label, args.ssh)))
            elif args.action == "remove":
                print(json.dumps(client.peer_remove(args.label)))
            elif args.action == "list":
                print(json.dumps(client.peer_list(), indent=2))
            else:
                parser.error("peer needs add, remove, or list")
        else:
            parser.error("unknown command %r" % args.command)
        return 0


def main(argv=None):
    return ClientCli().main(argv)


if __name__ == "__main__":
    sys.exit(main())