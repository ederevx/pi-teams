"""How to launch another pi without a shell, for the self-host fallback.

The TypeScript counterpart lives in extensions/pi-teams/paths.ts
(piInvocation). A Python daemon has no pi entry in its own argv, so the
loader that does know it passes the entry through the environment; the
extension also persists the same launch record under the team state root
so a broker started without the environment (a pre-v0.4.36 extension)
can still resolve the running runtime. This module owns that record's
path, field names, and precedence, and the extension keeps in sync.
"""

import json
import os
import shutil
import sys

# A JS entry is run by the runtime that owns it: npm's pi.cmd shim
# cannot be executed directly on Windows, and routing an argument list
# through the command shell would break on the multi-line prompt.
JS_SUFFIXES = (".js", ".mjs", ".cjs")

# The durable launch record, <root>/pi-entry.json, written by the
# extension (paths.ts persistPiInvocation) and, when it inherited the
# entry, by a broker at start (persist below). Fields:
#   version  1: record format version (int)
#   entry    absolute path to the pi runtime's entry script
#   node     runtime command that executes "entry"
#   command  launcher command used when no entry script applies
#   args     base argv appended to "command"
# Every field is optional and unknown fields or versions are ignored,
# so an older reader downgrades instead of failing.
ENTRY_FILE = "pi-entry.json"
ENTRY_VERSION = 1


def _entry_path(root):
    """The record path under a TeamRoot or a plain root path."""
    base = getattr(root, "base", root)
    return os.path.join(str(base), ENTRY_FILE)


class PiInvocation:
    """Resolves the command and base args that start a pi process."""

    @staticmethod
    def resolve(environ=None, entry=None, root=None):
        env = os.environ if environ is None else environ
        entry = entry or env.get("PI_TEAMS_PI_ENTRY")
        if entry and os.path.isfile(entry):
            return PiInvocation._entry(entry, env)
        command = env.get("PI_TEAMS_PI_COMMAND")
        if command:
            return command, list((env.get("PI_TEAMS_PI_ARGS") or "").split())
        persisted = PiInvocation._persisted(root)
        if persisted:
            return persisted
        return "pi", []

    @staticmethod
    def persist(root, environ=None, entry=None):
        """Write the resolved launch record under `root`, atomically,
        and return whether one was written. A resolution that is only
        the bare `pi` name is never written, so it cannot replace a
        usable record left by an earlier run."""
        writer = getattr(root, "write_atomic", None)
        if writer is None:
            return False
        record = PiInvocation._record(environ, entry)
        if record is None:
            return False
        writer(ENTRY_FILE, json.dumps(record) + "\n")
        return True

    @staticmethod
    def _record(environ, entry):
        """The launch record for the environment, or None when it
        resolves to nothing durable (the bare `pi` fallback)."""
        env = os.environ if environ is None else environ
        entry = entry or env.get("PI_TEAMS_PI_ENTRY")
        if entry and os.path.isfile(entry):
            record = {"version": ENTRY_VERSION, "entry": entry}
            node = env.get("PI_TEAMS_PI_NODE")
            if node:
                record["node"] = node
            return record
        command = env.get("PI_TEAMS_PI_COMMAND")
        if command and command != "pi":
            return {"version": ENTRY_VERSION, "command": command,
                    "args": list((env.get("PI_TEAMS_PI_ARGS") or "").split())}
        return None

    @staticmethod
    def _persisted(root):
        """The launch the record under `root` names, or None when it is
        absent, malformed, or names nothing usable."""
        record = PiInvocation._read_record(root)
        if not record:
            return None
        entry = record.get("entry")
        if isinstance(entry, str) and os.path.isfile(entry):
            env = {}
            node = record.get("node")
            if isinstance(node, str) and node:
                env["PI_TEAMS_PI_NODE"] = node
            return PiInvocation._entry(entry, env)
        command = record.get("command")
        if not isinstance(command, str) or not command or command == "pi":
            return None
        args = record.get("args")
        if not isinstance(args, list):
            args = []
        return command, [str(arg) for arg in args]

    @staticmethod
    def _read_record(root):
        if root is None:
            return None
        try:
            with open(_entry_path(root), "r", encoding="utf-8") as handle:
                record = json.load(handle)
        except (OSError, ValueError):
            return None
        return record if isinstance(record, dict) else None

    @staticmethod
    def _entry(entry, env):
        """The runtime that runs `entry`, with the entry as its argument.

        A named runtime wins: the record's `node` is the command that
        already runs this pi, while npm installs the launcher as a
        suffixless symlink (`node_modules/.bin/pi`) whose own name does
        not reveal that it is JavaScript.
        """
        runtime = env.get("PI_TEAMS_PI_NODE")
        if isinstance(runtime, str) and runtime:
            return runtime, [entry]
        if PiInvocation._is_javascript(entry):
            return (shutil.which("node") or "node"), [entry]
        return sys.executable, [entry]

    @staticmethod
    def _is_javascript(entry):
        """Whether `entry` names a JS file, following a symlink whose
        own name may carry no suffix (the npm launcher shim)."""
        if entry.lower().endswith(JS_SUFFIXES):
            return True
        try:
            target = os.path.realpath(entry)
        except OSError:
            return False
        return target.lower().endswith(JS_SUFFIXES)
