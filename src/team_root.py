"""Team root paths, constants, and atomic file access.

A team root is one broker's on-disk state: the endpoint it publishes,
the mirrored registry, its pid file, persisted peers, and the busy
files its agents use to report state. This module owns every path and
every atomic write under that root, so no other module has to know the
layout. It owns no runtime state and starts no threads.
"""

import json
import os
import pathlib
import time

DEFAULT_ROOT = os.path.join(os.path.expanduser("~"), ".local", "state", "pi-teams")
ENDPOINT_NAME = "endpoint"
REGISTRY_NAME = "registry.json"
PID_NAME = "teamd.pid"
PEERS_NAME = "peers.json"
BUSY_SUFFIX = ".busy"
# The extension's spawn prompt marks a forked teammate session; the broker
# uses it to tell teammate sessions apart from a user's own sessions. Keep
# in sync with taskPrompt() in extensions/pi-teams.ts.
TEAMMATE_MARKER = "a teammate spawned by a parent pi session"


class TeamRoot:
    """Owns the paths and atomic writes for one team root."""

    def __init__(self, root):
        self.base = pathlib.Path(root)
        self.endpoint = self.base / ENDPOINT_NAME
        self.registry = self.base / REGISTRY_NAME
        self.pidfile = self.base / PID_NAME
        self.peersfile = self.base / PEERS_NAME
        self._lockbase = self.base / ".broker.lock"
        self._lockpath = None

    def ensure(self):
        self.base.mkdir(parents=True, exist_ok=True)

    def write_atomic(self, relative, data, mode=0o644):
        self.ensure()
        target = self.base / relative
        tmp = self.base / ("%s.tmp.%d" % (relative, os.getpid()))
        tmp.write_text(data, encoding="utf-8")
        try:
            os.chmod(str(tmp), mode)
        except OSError:
            # Windows chmod only toggles the read-only bit.
            pass
        # On Windows os.replace can raise PermissionError while a reader
        # holds the destination open; retry briefly instead of failing.
        for attempt in range(11):
            try:
                os.replace(str(tmp), str(target))
                return
            except FileNotFoundError:
                # Mirror-only write: the owning root was removed (e.g. test
                # teardown raced a lingering connection thread). The
                # in-memory registry remains authoritative.
                return
            except PermissionError:
                if attempt >= 10:
                    return
                time.sleep(0.05)

    def read_endpoint(self):
        try:
            return json.loads(self.endpoint.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def read_peers(self):
        try:
            data = json.loads(self.peersfile.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def write_peers(self, peers):
        self.write_atomic(PEERS_NAME, json.dumps(peers, indent=2) + "\n")

    # -- busy files --------------------------------------------------

    def busy_files(self):
        # A failed scan yields nothing to sweep rather than failing the
        # whole liveness pass.
        try:
            return list(self.base.glob("*" + BUSY_SUFFIX))
        except OSError:
            return []

    def remove_busy_file(self, entry):
        path = (entry or {}).get("busy_file")
        if path:
            self.unlink_under(path, self.base)

    def unlink_under(self, path, root):
        # Guard a delete to the root that owns the file; a path outside it
        # is never removed.
        try:
            target = pathlib.Path(path).resolve()
            base = pathlib.Path(root).resolve()
            if base != target.parent and base not in target.parents:
                return
            target.unlink()
        except OSError:
            pass

    # -- single-broker lock ------------------------------------------

    def acquire_lock(self):
        # One broker per root. A lock left by a crashed or SIGKILLed
        # broker is reaped so the root never becomes permanently
        # unstartable; a live broker's lock is kept.
        for _ in range(2):
            try:
                self._lockbase.mkdir()
            except FileExistsError:
                if not self._reap_stale_lock():
                    return False
                continue
            try:
                (self._lockbase / "pid").write_text("%d\n" % os.getpid())
                self._lockpath = self._lockbase
            except OSError:
                try:
                    self._lockbase.rmdir()
                except OSError:
                    pass
                raise
            return True
        return False

    def release_lock(self):
        if self._lockpath is None:
            return
        try:
            (self._lockpath / "pid").unlink()
            self._lockpath.rmdir()
        except OSError:
            pass
        self._lockpath = None

    def _reap_stale_lock(self):
        # The pid file may lag mkdir by a moment, so give it a short
        # grace before deciding the lock is abandoned. Only a pid that is
        # provably gone makes the lock stale.
        pid = None
        for _ in range(5):
            pid = self._lock_pid()
            if pid is not None:
                break
            time.sleep(0.05)
        if pid is not None and self._pid_alive(pid):
            return False
        try:
            (self._lockbase / "pid").unlink()
        except OSError:
            pass
        try:
            self._lockbase.rmdir()
        except OSError:
            return False
        return True

    def _lock_pid(self):
        try:
            text = (self._lockbase / "pid").read_text(encoding="utf-8").strip()
        except OSError:
            return None
        try:
            return int(text)
        except ValueError:
            return None

    def _pid_alive(self, pid):
        if pid is None or pid <= 0:
            return False
        if os.name == "nt":
            return self._pid_alive_windows(pid)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            # Owned by another user: the process exists.
            return True
        except OSError:
            return True
        return True

    def _pid_alive_windows(self, pid):
        # os.kill(pid, 0) would TerminateProcess on Windows, so probe the
        # process handle instead. A handle that opens for a process that
        # already exited is not alive.
        try:
            import ctypes
            from ctypes import wintypes
        except ImportError:
            return False
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)