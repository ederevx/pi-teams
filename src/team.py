#!/usr/bin/env python3
"""team - the pi-teams client.

Speaks the broker protocol over its loopback TCP endpoint. Identity
comes from the environment (TEAM_ID, TEAM_NAME, TEAM_ROLE,
TEAM_PARENT_ID, TEAM_SESSION) or is derived from the process. One
TeamClient holds one persistent connection: while it stays open the
agent is reachable and broker relays arrive on it. The CLI offers
register, ls, send, follow, hold, terminate, fork, and deregister.

Liveness is connection-based on every platform: hold() keeps the
endpoint open and exits when the broker closes it (deregister), a
terminate notice arrives (parent gone or explicit kill), or the
connection drops (broker down). Nothing here kills processes or names
pids, so the client is portable across POSIX and Windows.
"""

import argparse
import json
import os
import random
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_teamd_dir = os.path.dirname(os.path.abspath(__file__))
if os.path.exists(os.path.join(_teamd_dir, "teamd.py")):
    from teamd import DEFAULT_ROOT, TeamRoot  # noqa: E402
else:
    # Installed layout names the broker binary `teamd` without a .py
    # extension, which import machinery cannot load; load it by path.
    import importlib.machinery
    import importlib.util

    _loader = importlib.machinery.SourceFileLoader(
        "teamd", os.path.join(_teamd_dir, "teamd")
    )
    _spec = importlib.util.spec_from_loader("teamd", _loader)
    _teamd = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_teamd)
    DEFAULT_ROOT = _teamd.DEFAULT_ROOT
    TeamRoot = _teamd.TeamRoot

HEARTBEAT_DEFAULT = 6.0


class TeamClient:
    """One agent's persistent connection to the team endpoint."""

    def __init__(self, root=None, timeout=2.0, heartbeat=HEARTBEAT_DEFAULT):
        self.root = TeamRoot(root or DEFAULT_ROOT)
        self.timeout = timeout
        self.heartbeat = heartbeat
        self.id = os.environ.get("TEAM_ID")
        self.name = os.environ.get("TEAM_NAME")
        self.role = os.environ.get("TEAM_ROLE")
        self.parent = os.environ.get("TEAM_PARENT_ID")
        self.session = os.environ.get("TEAM_SESSION")
        self.owner_pid = os.environ.get("TEAM_OWNER_PID")
        self.busy_file = os.environ.get("TEAM_BUSY_FILE")
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
            "parent": self.parent,
            "cwd": os.getcwd(),
            "session": self.session,
            "owner_pid": self.owner_pid,
        }

    def set_identity(self, agent_id=None, name=None, role=None, parent=None,
                     session=None, owner_pid=None, busy_file=None):
        # Explicit identity from CLI arguments (pi.exec cannot pass env
        # on Windows, so the extension hands identity over as args).
        if agent_id:
            self.id = agent_id
        if name:
            self.name = name
        if role:
            self.role = role
        if parent:
            self.parent = parent
        if session:
            self.session = session
        if owner_pid:
            self.owner_pid = owner_pid
        if busy_file:
            self.busy_file = busy_file

    # -- transport ---------------------------------------------------

    def connect(self):
        if self._conn is not None:
            return self._conn
        endpoint = self.root.read_endpoint()
        if not endpoint:
            raise OSError("no teamd endpoint under %s" % self.root.base)
        conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        conn.settimeout(self.timeout)
        conn.connect((endpoint["host"], endpoint["port"]))
        self._conn = conn
        self._send_line({"op": "hello", "token": endpoint.get("token") or ""})
        reply = self._read_line()
        if not reply or reply.get("op") != "ack":
            self.close()
            raise OSError("teamd handshake failed: %r" % (reply,))
        return self._conn

    def close(self):
        if self._conn is not None:
            try:
                self._conn.close()
            except OSError:
                pass
            self._conn = None

    def _send_line(self, obj):
        data = json.dumps(obj, separators=(",", ":")) + "\n"
        self.connect().sendall(data.encode())

    def _read_line(self):
        while b"\n" not in self._readbuf:
            chunk = self.connect().recv(65536)
            if not chunk:
                return None
            self._readbuf += chunk
        line, rest = self._readbuf.split(b"\n", 1)
        self._readbuf = rest
        return json.loads(line.decode("utf-8"))

    def send(self, obj):
        self._send_line(obj)

    def request(self, op, expected=("ack", "error", "registry"), **fields):
        self._send_line(dict(fields, op=op))
        while True:
            reply = self._read_line()
            if reply is None:
                return {"op": "error", "error": "closed"}
            if reply.get("op") in expected:
                return reply

    # -- operations --------------------------------------------------

    def register(self):
        reply = self.request("register", expected=("ack", "error"),
                             **self.meta())
        if self.heartbeat and self._conn is not None:
            threading.Thread(target=self._heartbeat, daemon=True).start()
        return reply

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

    # -- streaming ----------------------------------------------------

    def _heartbeat(self):
        while self._conn is not None:
            time.sleep(self.heartbeat)
            if self._conn is not None:
                try:
                    self._send_line({"op": "ping", "busy": self._is_busy()})
                except OSError:
                    break

    def _is_busy(self):
        if not self.busy_file:
            return False
        try:
            with open(self.busy_file) as fh:
                return fh.read().strip() == "1"
        except (OSError, IOError):
            return False

    def follow(self, on_message=None, ready=None):
        self.register()
        if ready is not None:
            ready()
        try:
            while True:
                try:
                    msg = self._read_line()
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
        stdin_dead = threading.Event()

        def watch_stdin():
            # When the spawner hosts us on a pipe or a PTY, EOF on
            # stdin means the hosting process is gone:
            # exit so the endpoint dies with its pi instead of pinging
            # forever as an orphan.
            try:
                while True:
                    if not sys.stdin.read(4096):
                        stdin_dead.set()
                        return
            except (OSError, ValueError):
                stdin_dead.set()

        if not sys.stdin.isatty():
            threading.Thread(target=watch_stdin, daemon=True).start()
        try:
            while True:
                try:
                    msg = self._read_line()
                except socket.timeout:
                    if stdin_dead.is_set():
                        return
                    continue
                except OSError:
                    break
                if msg is None:
                    return
                if msg.get("kind") == "terminate":
                    return
                if msg.get("op") == "message" and msg.get("kind") != "registry-change":
                    # Surface inbound traffic on stdout for the hosting
                    # extension to forward to its agent. Registry churn is
                    # internal bookkeeping, never agent-facing.
                    print(json.dumps(msg, separators=(",", ":")), flush=True)
                if stdin_dead.is_set():
                    return
        finally:
            self.close()

    # -- forking ------------------------------------------------------

    def fork(self, name, argv):
        self.register()
        fork_id, child_env = self._fork_identity(name)
        if not argv:
            argv = [sys.executable, os.path.abspath(__file__), "hold"]
        log = self._fork_log(fork_id)
        proc = self._spawn_fork(argv, child_env, log)
        return {"op": "forked", "id": fork_id, "pid": proc.pid,
                "log": str(log)}

    def _fork_identity(self, name):
        # Owns the child's fork identity; only the parent's id and session
        # are read from this client.
        fork_id = "fork-%d-%s" % (
            os.getpid(), "%08x" % random.getrandbits(32),
        )
        env = dict(os.environ)
        env["TEAM_ID"] = fork_id
        env["TEAM_NAME"] = name or fork_id
        env["TEAM_ROLE"] = "fork"
        env["TEAM_PARENT_ID"] = self.id
        if self.session:
            env["TEAM_SESSION"] = self.session
        return fork_id, env

    def _fork_log(self, fork_id):
        log = self.root.base / "forks" / ("%s.log" % fork_id)
        log.parent.mkdir(parents=True, exist_ok=True)
        return log

    def _spawn_fork(self, argv, env, log):
        logfile = open(str(log), "ab")
        return subprocess.Popen(
            argv,
            env=env,
            stdout=logfile,
            stderr=logfile,
        )


def parse_payload(text):
    try:
        return json.loads(text)
    except ValueError:
        return text


def add_identity_args(parser):
    parser.add_argument("--id")
    parser.add_argument("--name")
    parser.add_argument("--role")
    parser.add_argument("--parent")
    parser.add_argument("--session")
    parser.add_argument("--owner-pid")
    parser.add_argument("--busy-file")


def apply_identity(client, args):
    client.set_identity(args.id, args.name, args.role, args.parent,
                        args.session, args.owner_pid, args.busy_file)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="team", description="pi-teams client")
    parser.add_argument("--root", default=DEFAULT_ROOT)
    sub = parser.add_subparsers(dest="command")

    p_register = sub.add_parser("register")
    add_identity_args(p_register)
    sub.add_parser("ls")
    sub.add_parser("deregister")
    p_follow = sub.add_parser("follow")
    add_identity_args(p_follow)
    p_hold = sub.add_parser("hold")
    add_identity_args(p_hold)
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
    if args.command in ("register", "follow", "hold"):
        apply_identity(client, args)
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