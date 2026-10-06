"""SessionKeeper: the detached keeper for one self-hosted pi session.

One responsibility: given the spec SelfSessionHost wrote, launch the
`pi --mode rpc` child, deliver its initial prompt, hold the child's
stdin open for its lifetime, and publish then reclaim the keeper state
file. The keeper runs in its own detached session, so the teammate it
hosts survives the client that asked for it.
"""

import json
import os
import signal
import time

from process_runner import ProcessRunner
from team_root import TeamRoot


class SessionKeeper:
    """Owns one self-hosted session's child process and state file."""

    def __init__(self, root, key, runner=None):
        self.root = root if isinstance(root, TeamRoot) else TeamRoot(root)
        self.key = key
        self.runner = runner or ProcessRunner()
        self._child = None

    def run(self):
        """Consume the spec, host the child, and return an exit code."""
        spec = self.root.read_keeper_spec(self.key)
        if not spec:
            return 1
        # The spec carries the child's identity env (a send token); drop
        # it as soon as it is in memory, before the child is started.
        self.root.remove_keeper_spec(self.key)
        self._install_signals()
        self._child = self._launch(spec)
        if self._child is None:
            return 1
        self._write_prompt(spec.get("prompt") or "")
        self._publish_state(spec)
        self._hold()
        return 0

    def _launch(self, spec):
        argv = list(spec.get("argv") or [])
        if not argv:
            return None
        try:
            return self.runner.spawn_child(
                argv, env=spec.get("env") or None,
                cwd=spec.get("cwd") or None)
        except OSError:
            return None

    def _write_prompt(self, prompt):
        # The pi RPC protocol reads one JSON object per line.
        try:
            self._child.stdin.write(
                json.dumps({"type": "prompt", "message": prompt}) + "\n")
            self._child.stdin.flush()
        except (OSError, ValueError):
            pass

    def _publish_state(self, spec):
        record = {
            "key": self.key,
            "session": spec.get("session") or "",
            "keeper_pid": os.getpid(),
            "keeper_start": TeamRoot.process_start_mark(os.getpid()),
            "child_pid": self._child.pid,
            "child_start": TeamRoot.process_start_mark(self._child.pid),
            "created": spec.get("created") or time.time(),
        }
        self.root.write_keeper_state(self.key, record)

    def _hold(self):
        # wait() keeps the stdin pipe open for the child's whole life; a
        # closed pipe is the child's exit condition, so the keeper owns
        # the session lifetime.
        try:
            self._child.wait()
        except (OSError, ValueError):
            self._terminate()
        finally:
            self.root.remove_keeper_state(self.key)

    def _install_signals(self):
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(sig, self._on_signal)
            except (ValueError, OSError):
                continue

    def _on_signal(self, signum, frame):
        # An explicit stop must take the child down with the keeper and
        # leave no state behind for GC to find.
        self._terminate()
        self.root.remove_keeper_state(self.key)
        os._exit(0)

    def _terminate(self):
        if self._child is None:
            return
        try:
            self._child.kill()
        except OSError:
            pass
