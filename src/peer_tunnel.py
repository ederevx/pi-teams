"""One broker's SSH tunnel to a peer broker.

The broker owns the whole SSH transport: this class reads the peer
broker's loopback endpoint over a non-interactive ssh session, forwards
that port to a local loopback port, and owns the ssh process for its
whole life. Nothing outside this class knows SSH is involved, so the
rest of the broker links and relays peers without a transport branch.
"""

import json
import os
import shutil
import socket
import subprocess
import threading
import time

DEFAULT_REMOTE_STATE = "$HOME/.local/state/pi-teams"


class PeerUnreachable(Exception):
    """An ssh peer could not be reached non-interactively. `detail` is a
    short reason; `setup` is the one-time command a password-only host
    needs, for the user to run in a terminal."""

    def __init__(self, ssh, detail, setup):
        self.ssh = ssh
        self.detail = detail
        self.setup = setup
        super().__init__("peer %s unreachable: %s" % (ssh, detail))


class PeerTunnel:
    """Owns one ssh -L tunnel from this broker to a peer broker and
    registers the resulting loopback endpoint.

    The injected seams (ssh_bin, popen, which) keep the ssh process
    testable; the coordinator test injects a whole tunnel instead.
    """

    def __init__(self, label, ssh, ssh_bin=None, remote_state=None,
                 on_exit=None, popen=subprocess.Popen, which=shutil.which,
                 sleep=time.sleep):
        self.label = label
        self.ssh = ssh
        self.host = ""
        self._ssh_bin = ssh_bin or os.environ.get("PI_TEAMS_SSH") or "ssh"
        self._remote_state = (
            remote_state or os.environ.get("PI_TEAMS_REMOTE_STATE")
            or DEFAULT_REMOTE_STATE
        )
        self._on_exit = on_exit
        self._popen = popen
        self._which = which
        self._sleep = sleep
        self._proc = None
        self._endpoint = {}
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------

    def start(self):
        """Read the peer endpoint, open the tunnel, and return the local
        loopback endpoint to link. Raises PeerUnreachable."""
        self._require_ssh()
        endpoint = self._read_endpoint()
        self.host = str(endpoint.get("name") or self.label)
        port = self._reserve_port()
        proc = self._spawn_ssh(port, int(endpoint["port"]))
        with self._lock:
            self._proc = proc
            self._endpoint = {
                "host": "127.0.0.1",
                "port": port,
                "token": endpoint.get("token") or "",
                "name": self.host,
            }
        # ExitOnForwardFailure makes ssh leave at once when it cannot
        # bind the forwarded port; surface that as a start failure
        # instead of a link that silently never connects.
        self._sleep(0.2)
        if proc.poll() is not None:
            detail = self._drain_stderr(proc)
            with self._lock:
                self._proc = None
                self._endpoint = {}
            raise PeerUnreachable(self.ssh, self._classify(detail),
                                  self.setup_command())
        threading.Thread(target=self._wait, args=(proc,),
                         daemon=True).start()
        return dict(self._endpoint)

    def close(self):
        """Idempotently kill the ssh child; the wait thread then exits."""
        with self._lock:
            proc, self._proc = self._proc, None
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass

    def _wait(self, proc):
        # Drain stderr so a noisy ssh cannot fill its pipe and block,
        # then report an unexpected exit so the broker can drop the link.
        self._drain_stderr(proc)
        proc.wait()
        callback = self._on_exit
        if callback is not None:
            callback(self)

    # -- ssh seams ---------------------------------------------------

    def _require_ssh(self):
        if self._which(self._ssh_bin) is None:
            raise PeerUnreachable(
                self.ssh, "ssh is not installed or not on PATH",
                self.setup_command())

    def _read_endpoint(self):
        try:
            result = subprocess.run(
                [self._ssh_bin, "-o", "BatchMode=yes",
                 "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
                 self.ssh, "cat", "%s/endpoint" % self._remote_state],
                capture_output=True, text=True, timeout=25,
                encoding="utf-8", errors="replace",
            )
        except (OSError, subprocess.TimeoutExpired) as err:
            raise PeerUnreachable(self.ssh, str(err) or "ssh timed out",
                                  self.setup_command())
        if result.returncode != 0:
            raise PeerUnreachable(self.ssh,
                                  self._classify(result.stderr or ""),
                                  self.setup_command())
        try:
            return json.loads(result.stdout.strip())
        except ValueError:
            raise PeerUnreachable(self.ssh,
                                  "the endpoint file could not be read",
                                  self.setup_command())

    def _reserve_port(self):
        # A loopback port reserved and released at once: ssh binds it
        # when the tunnel starts. The listener never outlives this call.
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", 0))
            return probe.getsockname()[1]
        finally:
            probe.close()

    def _spawn_ssh(self, port, remote_port):
        kwargs = {}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(
                subprocess, "CREATE_NO_WINDOW", 0)
        return self._popen(
            [self._ssh_bin, "-N",
             "-o", "BatchMode=yes",
             "-o", "ExitOnForwardFailure=yes",
             "-o", "ServerAliveInterval=5",
             "-o", "ServerAliveCountMax=2",
             "-L", "127.0.0.1:%d:127.0.0.1:%d" % (port, remote_port),
             self.ssh],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, **kwargs,
        )

    def _drain_stderr(self, proc):
        # Bounded: ssh logs at most a few lines at ERROR level; keep the
        # tail so a start failure can be classified without unbounded
        # memory if ssh ever chatters.
        chunks = []
        stream = getattr(proc, "stderr", None)
        if stream is None:
            return ""
        try:
            for line in stream:
                chunks.append(line)
                if len(chunks) > 20:
                    del chunks[0]
        except (OSError, ValueError):
            pass
        return b"".join(chunks).decode("utf-8", "replace")

    # -- guidance ----------------------------------------------------

    def _classify(self, stderr):
        if "host key verification failed" in stderr.lower():
            return "the host key is not known or has changed"
        if "permission denied (" in stderr.lower():
            return "the host needs a password or a different key"
        for line in stderr.splitlines():
            if line.strip():
                return line.strip()
        return ""

    def _setup_script(self):
        explicit = os.environ.get("PI_TEAMS_PEER_SETUP")
        if explicit:
            return explicit
        here = os.path.dirname(os.path.abspath(__file__))
        for candidate in (
            os.path.join(here, "peer-ssh-setup"),
            os.path.join(here, os.pardir, "scripts", "peer-ssh-setup.sh"),
        ):
            if os.path.exists(candidate):
                return candidate
        return os.path.join(os.path.expanduser("~"), ".local", "bin",
                            "peer-ssh-setup")

    def setup_command(self):
        # A pi session's shell is Git Bash on Windows, where backslash
        # paths are not understood; emit forward slashes and single-quote
        # so a path or target with spaces is safe to paste.
        script = self._setup_script().replace(os.sep, "/")
        return "sh %s %s" % (self._quote(script), self._quote(self.ssh))

    @staticmethod
    def _quote(value):
        return "'" + str(value).replace("'", "'\\''") + "'"