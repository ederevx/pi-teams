"""Team root paths, constants, and atomic file access.

A team root is one broker's on-disk state: endpoint, mirrored registry,
pid file, persisted peers, and the agents' busy files. This module owns
every path and atomic write under that root (no other module knows the
layout); no runtime state, no threads.
"""

import json
import os
import pathlib
import re
import secrets
import time

from settings import PackageSettings

DEFAULT_ROOT = PackageSettings().state_dir()
ENDPOINT_NAME = "endpoint"
REGISTRY_NAME = "registry.json"
PID_NAME = "teamd.pid"
PEERS_NAME = "peers.json"
BUSY_SUFFIX = ".busy"
# The extension's spawn prompt marks a forked teammate session; the
# broker tells teammate sessions from a user's own by it. Keep in sync
# with taskPrompt() in extensions/pi-teams.ts.
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
        # Random scratch suffix: concurrent writers to one target
        # (registry mirroring) never clobber each other.
        tmp = self.base / ("%s.tmp.%d.%s"
                           % (relative, os.getpid(), secrets.token_hex(4)))
        tmp.write_text(data, encoding="utf-8")
        try:
            os.chmod(str(tmp), mode)
        except OSError:
            # Windows chmod only toggles the read-only bit.
            pass
        # Windows os.replace fails while a reader holds the destination
        # open; retry briefly instead of failing.
        for attempt in range(11):
            try:
                os.replace(str(tmp), str(target))
                return True
            except FileNotFoundError:
                # The owning root vanished (teardown raced a lingering
                # connection thread); memory stays authoritative.
                return False
            except PermissionError:
                if attempt >= 10:
                    break
                time.sleep(0.05)
        # The rename never succeeded: drop the scratch so a locked
        # destination cannot litter the root.
        try:
            tmp.unlink()
        except OSError:
            pass
        return False

    def tmp_files(self):
        # Scratch can sit below the root (a mailbox write), so the
        # scan is recursive.
        try:
            return sorted(self.base.rglob("*.tmp.*"))
        except OSError:
            return []

    def gc_tmp_files(self, now, grace):
        # A .tmp scratch survives only when every rename retry failed
        # under a holding reader; sweep the aged leftovers so a crashed
        # write cannot litter the root (any depth) forever.
        for path in self.tmp_files():
            try:
                if path.stat().st_mtime > now - grace:
                    continue
                path.unlink()
            except OSError:
                continue

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

    @staticmethod
    def safe_component(agent_id):
        # A host-qualified id carries a colon, illegal in a Windows
        # filename; the extension sanitizes busy-file names the same
        # way, so both live side by side under one root.
        return re.sub(r"[^A-Za-z0-9._-]", "-", str(agent_id or "agent"))

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

    # -- broker pid ---------------------------------------------------

    def write_pid(self):
        # Publishes the broker pid + start mark: readers tell the live
        # holder from a reused pid.
        self.write_atomic(PID_NAME, self._lock_record_text())

    def release_pid(self):
        # Remove the published broker pid only while this broker still
        # owns it: a newer broker that replaced the record keeps its
        # file. The delete stays guarded under the root.
        record = self._pid_record()
        if record is None:
            return
        own = {"pid": os.getpid(),
               "start": self.process_start_mark(os.getpid())}
        if record.get("pid") != own["pid"] \
                or record.get("start") != own["start"]:
            return
        self.unlink_under(self.pidfile, self.base)

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
                self._write_lock_record()
                self._lockpath = self._lockbase
            except OSError:
                try:
                    self._lockbase.rmdir()
                except OSError:
                    pass
                raise
            return True
        return False

    def _lock_record_text(self):
        # A pid alone cannot prove a lock abandoned: crashed pids are
        # reused, and poking a reused pid keeps the lock forever; the
        # start mark pins the holder.
        return json.dumps(
            {"pid": os.getpid(), "start": TeamRoot.process_start_mark(
                os.getpid())}) + "\n"

    def _write_lock_record(self):
        (self._lockbase / "pid").write_text(
            self._lock_record_text(), encoding="utf-8")

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
        # The pid file may lag mkdir by a moment (short grace). Stale
        # only when the holder is provably gone: a dead pid, or a live
        # pid whose start mark differs from the recorded one (reused
        # pid). An old-format record keeps the pid-only check.
        record = None
        for _ in range(5):
            record = self._lock_record()
            if record is not None:
                break
            time.sleep(0.05)
        else:
            return False
        pid = record.get("pid")
        if self._pid_alive(pid):
            recorded, live = record.get("start"), self.process_start_mark(pid)
            if recorded is None or live is None or recorded == live:
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

    def _lock_record(self):
        try:
            text = (self._lockbase / "pid").read_text(encoding="utf-8")
        except OSError:
            return None
        return self._parse_pid_record(text)

    def _pid_record(self):
        try:
            text = self.pidfile.read_text(encoding="utf-8")
        except OSError:
            return None
        return self._parse_pid_record(text)

    @staticmethod
    def _parse_pid_record(text):
        # The record: a plain pid (older brokers) or pid + start mark;
        # None when unreadable or malformed.
        try:
            return {"pid": int((text or "").strip()), "start": None}
        except ValueError:
            pass
        try:
            record = json.loads(text)
        except ValueError:
            return None
        if not isinstance(record, dict) or "pid" not in record:
            return None
        return record

    @staticmethod
    def process_start_mark(pid):
        """When `pid` started, stable across pid reuse: the /proc
        starttime field on Linux, the handle creation time on
        Windows, None elsewhere (liveness falls back to the pid
        probe)."""
        if pid is None or pid <= 0:
            return None
        if os.name == "nt":
            return TeamRoot._start_mark_windows(pid)
        try:
            with open("/proc/%d/stat" % pid, "rb") as fh:
                fields = fh.read().rsplit(b")", 1)[-1].split()
            return int(fields[19])
        except (OSError, ValueError, IndexError):
            return None

    @staticmethod
    def _start_mark_windows(pid):
        # Creation time via the handle probe; no handle, or an exit
        # code set (STILL_ACTIVE = 259), means no mark (reads dead).
        try:
            import ctypes
            from ctypes import wintypes
        except ImportError:
            return None
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            exit_code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(
                    handle, ctypes.byref(exit_code)) or exit_code.value != 259:
                return None
            created, exited, kernel_us, user_us = (
                wintypes.FILETIME() for _ in range(4))
            if not kernel32.GetProcessTimes(
                    handle, ctypes.byref(created), ctypes.byref(exited),
                    ctypes.byref(kernel_us), ctypes.byref(user_us)):
                return None
            return (created.dwHighDateTime << 32) | created.dwLowDateTime
        finally:
            kernel32.CloseHandle(handle)

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
            # Owned by another user: it exists.
            return True
        except OSError:
            return True
        return True

    def _pid_alive_windows(self, pid):
        # os.kill(pid, 0) would TerminateProcess on Windows, so probe
        # the start mark instead: it reads None for an exited process.
        return self.process_start_mark(pid) is not None