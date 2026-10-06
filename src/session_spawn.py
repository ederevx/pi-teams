"""Turning a spawn request into a hosted teammate session.

The broker owns the spawn contract but not the process: this selects a
session-host provider through the resolver and launches the teammate
there, and when no provider is available it falls back to the client's
own detached host. One responsibility: mint a teammate identity, get a
session running under it, and report the path that proved it hosted.
"""

import os
import secrets
import time

from pi_invocation import PiInvocation
from role_prompt import TEAM_ROLE_PROMPT
from self_host import SelfSessionHost
from session_provider import SessionHostResolver
from team_root import TeamRoot

# How long a started teammate has to prove it is hosted, and how often
# that proof is read. A sighting is confirmed by a second one, so a
# session that dies as it starts is not reported as served.
CONFIRM_TIMEOUT = 5.0
CONFIRM_INTERVAL = 0.2


class TeamSpawner:
    """Launches one teammate through a provider, else self-provisioned."""

    def __init__(self, root, environ=None, resolver_factory=None,
                 self_host=None, confirm_timeout=None):
        self.root = root if isinstance(root, TeamRoot) else TeamRoot(root)
        self.environ = os.environ if environ is None else environ
        self.self_host = self_host or SelfSessionHost(
            self.root, environ=self.environ)
        self._resolver_factory = resolver_factory or self._default_resolver
        self.confirm_timeout = (CONFIRM_TIMEOUT if confirm_timeout is None
                                else confirm_timeout)

    def spawn(self, parent, task, parent_pid=None, name=None, cwd=None,
              provider=None, model=None, thinking=None, session_dir=None):
        """Start one teammate; return {id, session, served}.

        The identity env is what the teammate's own extension adopts to
        self-register as a fork, so the hosted process needs no further
        coordination with this caller. Only a teammate whose host proved
        it running is reported; when no path can host it this raises, so
        the broker reports the failure instead of a phantom teammate.
        """
        fork_id = self._fork_id(parent_pid or parent)
        session = self._session(name, task)
        token = SelfSessionHost.mint_token()
        identity = self._identity(fork_id, session, parent)
        prompt = self.self_host.task_prompt(session, task)
        cwd = cwd or self.environ.get("PWD") or os.getcwd()
        try:
            self._serve_by_provider(session, cwd, identity, token, prompt,
                                    session_dir, provider, model, thinking)
            served = "provider"
        except OSError:
            self._serve_by_self(task, fork_id, session, parent, token, cwd,
                                session_dir, provider, model, thinking)
            served = "self"
        return {"id": fork_id, "session": session, "served": served}

    def _serve_by_provider(self, session, cwd, identity, token, prompt,
                           session_dir, provider, model, thinking):
        """Start the teammate on a provider and confirm it is hosted; a
        session that started but did not prove itself is reclaimed."""
        client = self._resolver_factory(lambda: None).resolve()
        reply = client.start(
            session, cwd,
            self._argv(session, prompt, session_dir, provider, model,
                       thinking),
            identity, {"TEAM_SEND_TOKEN": token})
        if not isinstance(reply, dict) or reply.get("ok") is not True:
            raise OSError("provider refused: %s"
                          % ((reply or {}).get("error") or "unknown"))
        if self._await(lambda: client.state(session)):
            return
        self._reclaim(lambda: client.stop(session))
        raise OSError("provider started no session")

    def _serve_by_self(self, task, fork_id, session, parent, token, cwd,
                       session_dir, provider, model, thinking):
        """Self-provision the teammate and confirm it is hosted; a keeper
        that did not prove itself is reclaimed."""
        self.self_host.spawn(
            task, fork_id, session=session, parent_id=parent,
            send_token=token, provider=provider, model=model,
            thinking=thinking, session_dir=session_dir, cwd=cwd)
        if self._await(lambda: self.self_host.hosted(fork_id)):
            return
        self._reclaim(lambda: self.self_host.abandon(fork_id))
        raise OSError("self-hosted keeper started no teammate")

    def _await(self, probe):
        """Whether `probe` finds the teammate twice within the window."""
        deadline = time.monotonic() + self.confirm_timeout
        interval = min(CONFIRM_INTERVAL, self.confirm_timeout / 2.0)
        while True:
            if probe() is not None:
                time.sleep(interval)
                if probe() is not None:
                    return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(interval)

    @staticmethod
    def _reclaim(reclaim):
        """Drop what this spawn created; never mask its own failure."""
        try:
            reclaim()
        except OSError:
            pass

    def _default_resolver(self, fallback):
        return SessionHostResolver(fallback=fallback, env=self.environ)

    @staticmethod
    def _fork_id(parent):
        text = str(parent or "0")
        digits = "".join(ch for ch in text.rsplit("-", 1)[-1]
                         if ch.isdigit())
        return "fork-%s-%s" % (digits[:8] or "0", secrets.token_hex(4))

    @staticmethod
    def _session(name, task):
        if name:
            return name
        slug = "".join(ch if ch.isalnum() else "-" for ch in task.strip()
                       )[:24].strip("-").lower()
        return "task-%s-%s" % (slug or "teammate", secrets.token_hex(3))

    def _argv(self, session, prompt, session_dir, provider, model, thinking):
        command, base = PiInvocation.resolve(self.environ, root=self.root)
        argv = [command] + list(base)
        if session_dir:
            argv += ["--session-dir", session_dir]
        argv += ["--name", session, "--append-system-prompt",
                 TEAM_ROLE_PROMPT]
        if provider:
            argv += ["--provider", provider]
        if model:
            argv += ["--model", model]
        if thinking:
            argv += ["--thinking", thinking]
        argv += [prompt]
        return argv

    def _identity(self, fork_id, session, parent):
        # Only non-secret identity is persisted by the provider; the send
        # token rides env_once and is re-minted by the teammate when a
        # revived session starts without it.
        return {
            "TEAM_ID": fork_id,
            "TEAM_NAME": session,
            "TEAM_ROLE": "fork",
            "TEAM_PARENT_ID": parent,
            "TEAM_ROOT": str(self.root.base),
        }
