"""Session-host client tests: directory parsing, provider selection, and
the control handshake against an in-test TCP endpoint server.

No live daemon is needed: the fake server speaks the same hello + one
JSON-line request framing, so the client's transport is exercised end to
end.
"""

import json
import os
import pathlib
import socket
import tempfile
import threading
import unittest

from harness import scratch_base
from service_registry import SessionHostDirectory
from session_host import SessionHostClient
from session_provider import SessionHostResolver


def _send(sock, obj):
    sock.sendall(json.dumps(obj).encode() + b"\n")


def _read(sock):
    buf = b""
    while b"\n" not in buf:
        data = sock.recv(65536)
        if not data:
            return None
        buf += data
    try:
        return json.loads(buf.split(b"\n", 1)[0].decode())
    except ValueError:
        return None


class FakeHostServer:
    """A loopback control endpoint speaking the daemon framing."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.host, self.port = self.sock.getsockname()
        self.token = "fake-token"
        self.requests = []
        self.sessions = {}
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def close(self):
        self._closed.set()
        try:
            self.sock.close()
        except OSError:
            pass

    def endpoint_file(self, path):
        pathlib.Path(path).write_text(
            json.dumps({"host": self.host, "port": self.port,
                        "token": self.token}),
            encoding="utf-8")

    def _serve(self):
        while not self._closed.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                break
            try:
                self._handle(conn)
            except OSError:
                pass
            finally:
                conn.close()

    def _handle(self, conn):
        hello = _read(conn)
        if not isinstance(hello, dict) or hello.get("cmd") != "hello" \
                or hello.get("token") != self.token:
            _send(conn, {"ok": False, "error": "bad-handshake"})
            return
        _send(conn, {"ok": True, "srv": "fake", "proto": 1})
        request = _read(conn)
        self.requests.append(request)
        _send(conn, self._dispatch(request or {}))

    def _dispatch(self, request):
        cmd = request.get("cmd")
        if cmd == "start":
            self.sessions[request["name"]] = request
            return {"ok": True, "name": request["name"], "created": True}
        if cmd == "stop":
            self.sessions.pop(request.get("name"), None)
            return {"ok": True}
        if cmd == "list":
            return {"ok": True, "sessions": sorted(self.sessions)}
        return {"ok": False, "error": "bad-request"}


class DirectoryCase(unittest.TestCase):
    """A scratch services root plus descriptor writers."""

    def setUp(self):
        self.base = pathlib.Path(tempfile.mkdtemp(
            prefix="pi-teams-session-host-", dir=scratch_base()))
        self.addCleanup(lambda: __import__("shutil").rmtree(
            self.base, ignore_errors=True))
        self.root = self.base / "services"
        (self.root / "session-host").mkdir(parents=True)

    def env(self, **extra):
        values = {"PI_SERVICES_DIR": str(self.root)}
        values.update(extra)
        return values

    def write_descriptor(self, name, payload=None, raw=None):
        path = self.root / "session-host" / (name + ".json")
        text = raw if raw is not None else json.dumps(payload)
        path.write_text(text, encoding="utf-8")
        return path

    def descriptor(self, provider, version=1, pid=None):
        return {"service": "session-host", "version": version,
                "protocol": "pi-pty-host/1", "provider": provider,
                "pid": os.getpid() if pid is None else pid,
                "endpoint_file": str(self.base / (provider + ".endpoint")),
                "unknown_field": {"kept": True}}


class DirectoryRootTests(unittest.TestCase):
    def test_root_precedence(self):
        override = SessionHostDirectory(env={"PI_SERVICES_DIR": "/svc",
                                             "XDG_RUNTIME_DIR": "/xdg"})
        self.assertEqual(str(override.root), "/svc")
        xdg = SessionHostDirectory(env={"XDG_RUNTIME_DIR": "/xdg"})
        self.assertEqual(str(xdg.root), os.path.join("/xdg", "pi-services"))
        temp = SessionHostDirectory(env={})
        self.assertEqual(
            str(temp.root),
            os.path.join(tempfile.gettempdir(), "pi-services"))


class DirectoryParseTests(DirectoryCase):
    def test_skips_malformed_and_other_services(self):
        self.write_descriptor("bad", raw="{not json")
        (self.root / "session-host" / "other.json").write_text(
            json.dumps({"service": "something-else"}), encoding="utf-8")
        self.write_descriptor("good", self.descriptor("good"))

        found = SessionHostDirectory(env=self.env()).descriptors()
        self.assertEqual([d["provider"] for d in found], ["good"])
        self.assertEqual(found[0]["unknown_field"], {"kept": True})

    def test_dead_pid_is_ignored_but_not_deleted(self):
        path = self.write_descriptor(
            "dead", self.descriptor("dead", pid=1 << 30))
        self.write_descriptor("live", self.descriptor("live"))

        directory = SessionHostDirectory(env=self.env())
        self.assertEqual([d["provider"] for d in directory.descriptors()],
                         ["dead", "live"])
        self.assertEqual(
            [d["provider"] for d in directory.live_descriptors()], ["live"])
        self.assertTrue(path.exists())


class ClientTests(DirectoryCase):
    def setUp(self):
        super().setUp()
        self.server = FakeHostServer()
        self.addCleanup(self.server.close)
        endpoint = self.base / "provider.endpoint"
        self.server.endpoint_file(endpoint)
        self.client = SessionHostClient(self.descriptor("provider"))

    def test_handshake_start_with_and_without_env(self):
        plain = self.client.start("s1", str(self.base), ["pi", "--fresh"])
        self.assertTrue(plain["ok"])
        self.assertEqual(self.server.requests[-1],
                         {"cmd": "start", "name": "s1", "dir": str(self.base),
                          "argv": ["pi", "--fresh"]})
        with_env = self.client.start("s2", str(self.base), ["pi"],
                                     env={"PI_STATE": "/x"})
        self.assertTrue(with_env["ok"])
        self.assertEqual(self.server.requests[-1]["env"], {"PI_STATE": "/x"})
        once = self.client.start("s3", str(self.base), ["pi"],
                                 env={"TEAM_ID": "f"},
                                 env_once={"TEAM_SEND_TOKEN": "s"})
        self.assertTrue(once["ok"])
        self.assertEqual(self.server.requests[-1]["env"],
                         {"TEAM_ID": "f"})
        self.assertEqual(self.server.requests[-1]["env_once"],
                         {"TEAM_SEND_TOKEN": "s"})

    def test_stop_and_list(self):
        self.client.start("s1", str(self.base), ["pi"])
        self.assertTrue(self.client.stop("s1")["ok"])
        listing = self.client.list()
        self.assertTrue(listing["ok"])
        self.assertEqual(listing["sessions"], [])

    def test_bad_endpoint_reads_as_oserror(self):
        broken = SessionHostClient(
            {"service": "session-host", "provider": "x",
             "endpoint_file": str(self.base / "missing.endpoint")})
        with self.assertRaises(OSError):
            broken.list()


class ResolverTests(DirectoryCase):
    def setUp(self):
        super().setUp()
        self.server = FakeHostServer()
        self.addCleanup(self.server.close)
        self.server.endpoint_file(self.base / "live.endpoint")

    def live_descriptor(self, provider, version):
        return {"service": "session-host", "version": version,
                "protocol": "pi-pty-host/1", "provider": provider,
                "pid": os.getpid(),
                "endpoint_file": str(self.base / "live.endpoint")}

    def resolver(self, **kwargs):
        calls = []
        resolver = SessionHostResolver(
            fallback=lambda: calls.append(True),
            directory=SessionHostDirectory(env=self.env()),
            sleep=lambda _seconds: None, attempts=2, **kwargs)
        return resolver, calls

    def test_picks_highest_live_version(self):
        self.write_descriptor("v1", self.live_descriptor("v1", 1))
        self.write_descriptor("v3", self.live_descriptor("v3", 3))
        self.write_descriptor("v2", self.live_descriptor("v2", 2))
        resolver, calls = self.resolver()
        client = resolver.resolve()
        self.assertEqual(client.descriptor["provider"], "v3")
        self.assertEqual(calls, [])

    def test_activates_dead_provider_once_then_binds(self):
        self.write_descriptor(
            "dormant",
            {"service": "session-host", "version": 1,
             "protocol": "pi-pty-host/1", "provider": "dormant",
             "pid": 1 << 30,
             "endpoint_file": str(self.base / "dormant.endpoint"),
             "activation": {"kind": "exec", "argv": ["start-me"]}})
        activated = []

        def runner(argv):
            activated.append(argv)
            self.write_descriptor("dormant",
                                  self.live_descriptor("dormant", 1))

        resolver, calls = self.resolver(activation_runner=runner)
        client = resolver.resolve()
        self.assertEqual(client.descriptor["provider"], "dormant")
        self.assertEqual(activated, [["start-me"]])
        self.assertEqual(calls, [])

    def test_non_exec_activation_falls_back(self):
        self.write_descriptor(
            "dormant",
            {"service": "session-host", "version": 1,
             "protocol": "pi-pty-host/1", "provider": "dormant",
             "pid": 1 << 30,
             "endpoint_file": str(self.base / "dormant.endpoint"),
             "activation": {"kind": "socket", "argv": ["start-me"]}})
        launched = []
        resolver, calls = self.resolver(
            activation_runner=lambda argv: launched.append(argv))
        with self.assertRaises(OSError):
            resolver.resolve()
        self.assertEqual(launched, [])
        self.assertEqual(calls, [True])

    def test_descriptor_returned_by_fallback_is_used(self):
        def fallback():
            return self.live_descriptor("provisioned", 1)

        resolver = SessionHostResolver(
            fallback=fallback,
            directory=SessionHostDirectory(env=self.env()),
            sleep=lambda _seconds: None, attempts=1)
        client = resolver.resolve()
        self.assertEqual(client.descriptor["provider"], "provisioned")
