"""How to launch another pi without a shell, for the self-host fallback.

The TypeScript counterpart lives in extensions/pi-teams/paths.ts
(piInvocation) and resolves the running runtime's entry so a Windows
launcher shim is never executed directly. A Python daemon has no pi
entry in its own argv, so the loader that does know it passes the entry
through the environment instead; failing that, a configured command is
used, and only then the bare `pi` name.
"""

import os
import shutil
import sys

# A JS entry is run by the runtime that owns it: npm's pi.cmd shim
# cannot be executed directly on Windows, and routing an argument list
# through the command shell would break on the multi-line prompt.
JS_SUFFIXES = (".js", ".mjs", ".cjs")


class PiInvocation:
    """Resolves the command and base args that start a pi process."""

    @staticmethod
    def resolve(environ=None, entry=None):
        env = os.environ if environ is None else environ
        entry = entry or env.get("PI_TEAMS_PI_ENTRY")
        if entry and os.path.isfile(entry):
            return PiInvocation._entry(entry, env)
        command = env.get("PI_TEAMS_PI_COMMAND")
        if command:
            return command, list((env.get("PI_TEAMS_PI_ARGS") or "").split())
        return "pi", []

    @staticmethod
    def _entry(entry, env):
        """The runtime that runs `entry`, with the entry as its argument."""
        if entry.lower().endswith(JS_SUFFIXES):
            node = (env.get("PI_TEAMS_PI_NODE") or shutil.which("node")
                    or "node")
            return node, [entry]
        return sys.executable, [entry]
