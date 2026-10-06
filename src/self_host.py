"""SelfSessionHost: the client-side fallback that hosts its own pi session.

When no session-host provider is available the client implements the
capability itself. One responsibility: spawn a detached per-session
keeper that owns a `pi --mode rpc` teammate, and make that keeper
findable, stoppable, and reclaimable under the team root. The keeper is
a separate process and this class never holds the child's pipe, so the
hosted session survives the daemon that asked for it.

The teammate argv/env mirror the extension's teammateArgs/teammateEnv
(extensions/pi-teams/agent.ts) so a self-hosted teammate self-registers
with the broker exactly as a provider-hosted one. Keep the role prompt
in sync with extensions/pi-teams/roles.ts (via role_prompt).
"""

import os
import re
import secrets
import signal
import sys
import time

from pi_invocation import PiInvocation
from process_runner import ProcessRunner
from role_prompt import TEAM_ROLE_PROMPT
from team_root import TeamRoot

# A spec older than this belonged to a launcher that died before its
# keeper consumed it; the local GC reclaims it.
SPEC_GRACE = 300.0
# Inherited variables that bind a process to a host session; dropped
# before a teammate's own identity is applied.
_BOUND_ENV = re.compile(
    r"^(PI_(SESSION|HOST)|TEAM_(ATTACHED|SESSION|HOST))")


class SelfSessionHost:
    """Spawns detached keepers for self-provisioned pi sessions."""

    def __init__(self, root, runner=None, environ=None, interpreter=None,
                 team_bin=None, role_prompt=None):
        self.root = root if isinstance(root, TeamRoot) else TeamRoot(root)
        self.runner = runner or ProcessRunner()
        self.environ = os.environ if environ is None else environ
        self.interpreter = interpreter or sys.executable
        self.team_bin = team_bin or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "team.py")
        self.role_prompt = role_prompt or TEAM_ROLE_PROMPT

    # -- spawning ----------------------------------------------------

    def spawn(self, task, fork_id, session=None, parent_id=None,
              send_token=None, provider=None, model=None, thinking=None,
              session_dir=None, pi_command=None, pi_args=(), extra_env=None,
              cwd=None):
        """Spawn the detached keeper for one teammate; return its key.

        `fork_id` is the teammate's TEAM_ID and the keeper's lookup key.
        The child argv/env are written to a spec the keeper consumes, so
        this call does not depend on the keeper's lifetime.
        """
        # Reclaim keepers that died since the last spawn before adding
        # another entry to the tree.
        self.gc()
        session = session or fork_id
        parent_id = parent_id or self.environ.get("TEAM_ID") or ""
        send_token = send_token or self.mint_token()
        command, base_args = self._invocation(pi_command, pi_args)
        argv = [command] + base_args + self._teammate_args(
            session, session_dir, provider, model, thinking)
        spec = {
            "key": fork_id,
            "session": session,
            "argv": argv,
            "env": self._teammate_env(
                fork_id, session, parent_id, send_token, extra_env),
            "cwd": cwd or os.getcwd(),
            "prompt": self.task_prompt(session, task),
            "created": time.time(),
        }
        self.root.write_keeper_spec(fork_id, spec)
        keeper_argv = [self.interpreter, self.team_bin, "--root",
                       str(self.root.base), "keeper", fork_id]
        try:
            self.runner.spawn_detached(keeper_argv)
        except OSError:
            self.root.remove_keeper_spec(fork_id)
            raise
        return fork_id

    def _invocation(self, pi_command, pi_args):
        if pi_command:
            return pi_command, list(pi_args)
        return PiInvocation.resolve(self.environ, root=self.root)

    # -- lifecycle ---------------------------------------------------

    def find(self, key):
        """The keeper state for `key` while its keeper is alive, else
        None; a dead keeper's state is reclaimed on the way out."""
        record = self.root.read_keeper_state(key)
        if not record:
            return None
        if self._alive(record, "keeper_pid", "keeper_start"):
            return record
        self.root.remove_keeper_state(key)
        return None

    def hosted(self, key):
        """The keeper state for `key` while the teammate still runs: the
        keeper and the child it launched are both the recorded live
        processes, so a keeper whose child died is not a hosted one."""
        record = self.find(key)
        if not record or not self._alive(record, "child_pid",
                                         "child_start"):
            return None
        return record

    def stop(self, key, why="requested"):
        """Stop the keeper for `key` and drop its state."""
        record = self.root.read_keeper_state(key)
        if not record:
            return False
        pid = record.get("keeper_pid")
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            pid = None
        if pid and self.root.process_alive(pid):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        self.root.remove_keeper_state(key)
        return True

    def abandon(self, key):
        """Reclaim a teammate this host started but did not confirm: stop
        its keeper, then drop its state and any unconsumed spec."""
        self.stop(key, why="unconfirmed")
        self.root.remove_keeper_spec(key)

    def gc(self, now=None, spec_grace=SPEC_GRACE):
        """Reclaim dead keepers' state and abandoned specs; return the
        removed paths. Only this root's byproducts are touched."""
        now = time.time() if now is None else now
        removed = []
        for path, record in self.root.keeper_states():
            if self._alive(record, "keeper_pid", "keeper_start"):
                continue
            self.root.unlink_under(str(path), self.root.base)
            removed.append(str(path))
        for path, _record in self.root.keeper_specs():
            try:
                if path.stat().st_mtime > now - spec_grace:
                    continue
            except OSError:
                continue
            self.root.unlink_under(str(path), self.root.base)
            removed.append(str(path))
        return removed

    def _alive(self, record, pid_key, start_key):
        # A pid alone cannot prove the recorded process still lives: a
        # reused pid would pin its state forever, so the recorded start
        # mark is compared when both sides have one.
        try:
            pid = int(record.get(pid_key))
        except (TypeError, ValueError):
            return False
        if not self.root.process_alive(pid):
            return False
        recorded = record.get(start_key)
        live = TeamRoot.process_start_mark(pid)
        if recorded and live and str(recorded) != str(live):
            return False
        return True

    # -- teammate argv/env -------------------------------------------

    def _teammate_args(self, session, session_dir, provider, model, thinking):
        role = self.role_prompt
        args = ["--mode", "rpc"]
        if session_dir:
            args += ["--session-dir", session_dir]
        args += ["--name", session, "--append-system-prompt", role]
        if provider:
            args += ["--provider", provider]
        if model:
            args += ["--model", model]
        if thinking:
            args += ["--thinking", thinking]
        return args

    def _teammate_env(self, fork_id, session, parent_id, send_token,
                      extra_env):
        env = {key: value for key, value in self.environ.items()
               if not _BOUND_ENV.match(key)}
        env.update({
            "TEAM_ID": fork_id,
            "TEAM_NAME": session,
            "TEAM_ROLE": "fork",
            "TEAM_PARENT_ID": parent_id,
            "TEAM_ROOT": str(self.root.base),
            "TEAM_SEND_TOKEN": send_token,
        })
        if extra_env:
            env.update({key: value for key, value in extra_env.items()
                        if value is not None})
        return env

    def task_prompt(self, session, task):
        send = self._report_command()
        return (
            'You are "%s", a teammate spawned by a parent pi session '
            "to do one task. Report the outcome to your parent by running "
            "this command:\n  %s\nTask:\n%s" % (session, send, task))

    def _report_command(self):
        return "%s %s --root \"$TEAM_ROOT\" send \"$TEAM_PARENT_ID\" " \
            "result \"<report>\"" % (
                self._quote(self.interpreter), self._quote(self.team_bin))

    @staticmethod
    def _quote(value):
        return "'" + str(value).replace("'", "'\\''") + "'"

    @staticmethod
    def mint_token():
        # Mirrors mintSendToken in extensions/pi-teams/protocol.ts.
        return "stk-%x-%s%s" % (
            int(time.time() * 1000), secrets.token_hex(4),
            secrets.token_hex(4))
