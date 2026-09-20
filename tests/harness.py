"""Test harness: temp team roots, brokers, and client helpers."""

import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time

SRC = pathlib.Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(SRC))

TEAMD = SRC / "teamd.py"
TEAM = SRC / "team.py"


def scratch_base():
    fallback = os.path.join(
        os.path.expanduser("~"), "tmp", "pi-teams-sandbox"
    )
    base = os.environ.get("TMPDIR") or fallback
    pathlib.Path(base).mkdir(parents=True, exist_ok=True)
    return base


def make_root():
    return str(pathlib.Path(
        tempfile.mkdtemp(prefix="pi-teams-", dir=scratch_base())
    ))


def start_broker(root, idle_timeout=15.0):
    proc = subprocess.Popen(
        [sys.executable, str(TEAMD), "--root", root,
         "--idle-timeout", str(idle_timeout), "start"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    wait_endpoint(root)
    return proc


def read_endpoint(root):
    return json.loads((pathlib.Path(root) / "endpoint").read_text())


def wait_endpoint(root, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            ep = read_endpoint(root)
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            probe.settimeout(0.5)
            probe.connect((ep["host"], ep["port"]))
            probe.close()
            return ep
        except (KeyError, OSError, ValueError):
            time.sleep(0.05)
    raise RuntimeError("broker did not come up at %s" % root)


def stop_broker(root, proc):
    subprocess.run(
        [sys.executable, str(TEAMD), "--root", root, "stop"],
        capture_output=True,
        timeout=5,
    )
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def team_proc(root, argv, env=None, stdin=subprocess.PIPE):
    full = dict(os.environ)
    if env:
        full.update(env)
    return subprocess.Popen(
        [sys.executable, str(TEAM), "--root", root] + argv,
        stdin=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=full,
    )


def run_team(root, argv, env=None):
    proc = team_proc(root, argv, env=env)
    out, err = proc.communicate(timeout=10)
    return proc.returncode, out.decode("utf-8"), err.decode("utf-8")


def wait_until(predicate, timeout=6.0, interval=0.2):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False