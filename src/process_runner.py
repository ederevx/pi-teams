"""OS child launches for the self-host fallback.

The one seam the self-host host uses to start processes. A detached
launch mirrors the extension's ProcessRunner.spawnPersistent: setsid on
POSIX, DETACHED_PROCESS on Windows, so a keeper outlives the daemon that
started it and never holds the daemon's pipe. A plain child launch
starts the keeper's pi with the console hidden on Windows, the way the
extension's spawnHidden does.
"""

import os
import subprocess


class ProcessRunner:
    """Launches detached keepers and their plain pi children."""

    @staticmethod
    def detach_kwargs():
        """The platform detachment flags, exposed so a test can assert
        the setsid/detached choice without starting a process."""
        if os.name == "nt":
            return {"creationflags": (subprocess.DETACHED_PROCESS
                                      | subprocess.CREATE_NEW_PROCESS_GROUP)}
        return {"start_new_session": True}

    def spawn_detached(self, argv, env=None, cwd=None):
        # The keeper's own stdin is /dev/null: it never depends on the
        # launcher's pipe and stays alive on its own session.
        return subprocess.Popen(
            list(argv), env=env, cwd=cwd,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, **self.detach_kwargs())

    def spawn_child(self, argv, env=None, cwd=None):
        # The pi RPC child reads its prompt from this pipe; the keeper
        # keeps the write end open for the child's lifetime.
        kwargs = {}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(
                subprocess, "CREATE_NO_WINDOW", 0)
        return subprocess.Popen(
            list(argv), env=env, cwd=cwd,
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, **kwargs)
