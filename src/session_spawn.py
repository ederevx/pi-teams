"""Turning a spawn request into a hosted teammate session.

The broker owns the spawn contract but not the process: this selects a
session-host provider through the resolver and launches the teammate
there, and when no provider is available it falls back to the client's
own detached host. One responsibility: mint a teammate identity and get
a session running under it, reporting which path served it.
"""

import os
import secrets

from pi_invocation import PiInvocation
from role_prompt import TEAM_ROLE_PROMPT
from self_host import SelfSessionHost
from session_provider import SessionHostResolver
from team_root import TeamRoot


class TeamSpawner:
    """Launches one teammate through a provider, else self-provisioned."""

    def __init__(self, root, environ=None, resolver_factory=None,
                 self_host=None):
        self.root = root if isinstance(root, TeamRoot) else TeamRoot(root)
        self.environ = os.environ if environ is None else environ
        self.self_host = self_host or SelfSessionHost(
            self.root, environ=self.environ)
        self._resolver_factory = resolver_factory or self._default_resolver

    def spawn(self, parent, task, parent_pid=None, name=None, cwd=None,
              provider=None, model=None, thinking=None, session_dir=None):
        """Start one teammate; return {id, session, served}.

        The identity env is what the teammate's own extension adopts to
        self-register as a fork, so the hosted process needs no further
        coordination with this caller.
        """
        fork_id = self._fork_id(parent_pid or parent)
        session = self._session(name, task)
        token = SelfSessionHost.mint_token()
        prompt = self.self_host.task_prompt(session, task)
        cwd = cwd or self.environ.get("PWD") or os.getcwd()
        served = "self"
        try:
            client = self._resolver_factory(lambda: None).resolve()
            reply = client.start(
                session, cwd,
                self._argv(session, prompt, session_dir, provider, model,
                           thinking),
                self._identity(fork_id, session, parent),
                {"TEAM_SEND_TOKEN": token})
            if not isinstance(reply, dict) or reply.get("ok") is not True:
                raise OSError(
                    "provider refused: %s"
                    % ((reply or {}).get("error") or "unknown"))
            served = "provider"
        except OSError:
            self.self_host.spawn(
                task, fork_id, session=session, parent_id=parent,
                send_token=token, provider=provider, model=model,
                thinking=thinking, session_dir=session_dir, cwd=cwd)
        return {"id": fork_id, "session": session, "served": served}

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
        command, base = PiInvocation.resolve(self.environ)
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
