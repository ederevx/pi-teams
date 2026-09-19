#!/usr/bin/env python3
"""team - the pi-teams client.

Speaks the broker protocol over the team socket. Identity comes from the
environment (TEAM_ID, TEAM_NAME, TEAM_ROLE, TEAM_PARENT_ID, TEAM_PID,
TEAM_SESSION) or is derived from the process. One TeamClient holds one
persistent connection: while it stays open the agent is reachable and
broker relays arrive on it. The CLI offers register, ls, send, follow,
terminate, fork, and a held child used by tests.

A fork is a child process whose environment names this agent as its
parent; the broker terminates a fork once the parent process dies, so a
team cannot outlive the agent that spawned it. The broker (teamd) does
the enforcement - no per-child watchdog process is needed.
"""

import argparse
import json
import os
import random
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from teamd import DEFAULT_ROOT, TeamRoot  # noqa: E402


class TeamClient:
    """One agent's persistent connection to the team socket."""

    def __init__(self, root=None, timeout=2.0):
        self.root = TeamRoot(root or DEFAULT_ROOT)
        self.timeout = timeout
        self.id = os.environ.get("TEAM_ID")
        self.name = os.environ.get("TEAM_NAME")
        self.role = os.environ.get("TEAM_ROLE")
        self.parent = os.environ.get("TEAM_PARENT_ID")
        self.session = os.environ.get("TEAM_SESSION")
        self.forced_pid = os.environ.get("TEAM_PID")
        self._conn = None
        self._readbuf = b""

    # -- identity ----------------------------------------------------

    def ensure_id(self):
        if not self.id:
            self.id = "cli-%d-%s" % (
                os.getpid(),
                "%08x" % random.getrandbits(32),
            )
        if not self.name:
            self.name = self.id
        return self.id

    def meta(self):
        return {
            "id": self.ensure_id(),
            "name": self.name,
            "role": self.role or "cli",
            "pid": int(self.forced_pid or os.getpid()),
            "parent": self.parent,
            "cwd": os.getcwd(),
            "session": self.session,
        }

    # -- transport ---------------------------------------------------

    def connect(self):
        if self._conn is not None:
            return self._conn
        self._conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._conn.settimeout(self.timeout)
        self._conn.connect(str(self.root.sock))
        return self._conn

    def close(self):
        if self._conn is not None:
            try:
                self._conn.close()
            except OSError:
                pass
            self._conn = None

    def send(self, obj):
        data = json.dumps(obj, separators=(",", ":")) + "\n"
        self.connect().sendall(data.encode())

    def recv(self):
        while b"\n" not in self._readbuf:
            chunk = self.connect().recv(65536)
            if not chunk:
                return None
            self._readbuf += chunk
        line, rest = self._readbuf.split(b"\n", 1)
        self._readbuf = rest
        return json.loads(line.decode("utf-8"))

    def request(self, op, expected=("ack", "error", "registry"), **fields):
        self.send(dict(fields, op=op))
        while True:
            reply = self.recv()
            if reply is None:
                return {"op": "error", "error": "closed"}
            if reply.get("op") in expected:
                return reply

    # -- operations --------------------------------------------------

    def register(self):
        return self.request("register", expected=("ack", "error"),
                            **self.meta())

    def send_msg(self, to, kind, payload):
        return self.request(
            "send", expected=("ack", "error"), to=to,
            **{"from": self.ensure_id()}, kind=kind, payload=payload,
            ts=time.time(),
        )

    def ls(self):
        return self.request("ls", expected=("registry", "error"))

    def terminate(self, agent_id, why="requested"):
        return self.request("terminate", expected=("ack", "error"),
                            to=agent_id, why=why)

    def deregister(self):
        reply = self.request("deregister", expected=("ack", "error"))
        self.close()
        return reply

    # -- streaming / forking ------------------------------------------

    def follow(self, on_message=None, ready=None):
        self.register()
        if ready is not None:
            ready()
        try:
            while True:
                try:
                    msg = self.recv()
                except socket.timeout:
                    continue
                except OSError:
                    break
                if msg is None:
                    break
                if on_message is not None:
                    on_message(msg)
                else:
                    print(json.dumps(msg, separators=(",", ":")),
                          flush=True)
        finally:
            self.close()

    def hold(self):
        self.register()
        watch = os.environ.get("TEAM_WATCH_PID")
        try:
            while True:
                if watch and not self._pid_alive(int(watch)):
                    return
                time.sleep(0.5)
        finally:
            self.close()

    @staticmethod
    def _pid_alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def fork(self, name, argv):
        self.register()
        child_env = dict(os.environ)
        child_env["TEAM_ID"] = "fork-%d-%s" % (
            os.getpid(), "%08x" % random.getrandbits(32),
        )
        child_env["TEAM_NAME"] = name or child_env["TEAM_ID"]
        child_env["TEAM_ROLE"] = "fork"
        child_env["TEAM_PARENT_ID"] = self.id
        child_env.pop("TEAM_PID", None)
        if self.session:
            child_env["TEAM_SESSION"] = self.session
        if not argv:
            argv = [sys.executable, os.path.abspath(__file__),
                    "child", "--hold"]
        log = self.root.base / "forks" / ("%s.log" % child_env["TEAM_ID"])
        log.parent.mkdir(parents=True, exist_ok=True)
        logfile = open(str(log), "ab")
        proc = subprocess.Popen(
            argv,
            env=child_env,
            stdout=logfile,
            stderr=logfile,
            start_new_session=True,
        )
        return {"op": "forked", "id": child_env["TEAM_ID"], "pid": proc.pid,
                "log": str(log)}


def parse_payload(text):
    try:
        return json.loads(text)
    except ValueError:
        return text


def main(argv=None):
    parser = argparse.ArgumentParser(prog="team", description="pi-teams client")
    parser.add_argument("--root", default=DEFAULT_ROOT)
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("register")
    sub.add_parser("ls")
    sub.add_parser("deregister")
    sub.add_parser("follow")
    p_child = sub.add_parser("child")
    p_child.add_argument("mode", choices=["hold"])
    p_send = sub.add_parser("send")
    p_send.add_argument("to")
    p_send.add_argument("kind", nargs="?", default="text")
    p_send.add_argument("payload", nargs="?", default="")
    p_term = sub.add_parser("terminate")
    p_term.add_argument("to")
    p_term.add_argument("why", nargs="?", default="requested")
    p_fork = sub.add_parser("fork")
    p_fork.add_argument("--name")
    p_fork.add_argument("--argv", nargs="+")

    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    client = TeamClient(args.root)
    if args.command == "register":
        print(json.dumps(client.register()))
    elif args.command == "ls":
        print(json.dumps(client.ls(), indent=2))
    elif args.command == "deregister":
        print(json.dumps(client.deregister()))
    elif args.command == "follow":
        client.follow()
    elif args.command == "child":
        client.hold()
    elif args.command == "send":
        print(json.dumps(
            client.send_msg(args.to, args.kind, parse_payload(args.payload))
        ))
    elif args.command == "terminate":
        print(json.dumps(client.terminate(args.to, args.why)))
    elif args.command == "fork":
        print(json.dumps(client.fork(args.name, args.argv)))
    else:
        parser.error("unknown command %r" % args.command)
    return 0


if __name__ == "__main__":
    sys.exit(main())