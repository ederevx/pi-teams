"""How to launch another pi without a shell, for the self-host fallback.

The TypeScript counterpart lives in extensions/pi-teams/paths.ts
(piInvocation) and resolves the running runtime's entry so a Windows
launcher shim is never executed directly. A Python daemon has no pi
entry in its own argv, so this resolves the same intent from the
environment instead: an explicit entry replayed through this
interpreter, then a configured command, then the bare `pi` name.
"""

import os
import sys


class PiInvocation:
    """Resolves the command and base args that start a pi process."""

    @staticmethod
    def resolve(environ=None, entry=None):
        env = os.environ if environ is None else environ
        entry = entry or env.get("PI_TEAMS_PI_ENTRY")
        if entry and os.path.isfile(entry):
            return sys.executable, [entry]
        command = env.get("PI_TEAMS_PI_COMMAND")
        if command:
            return command, list((env.get("PI_TEAMS_PI_ARGS") or "").split())
        return "pi", []
