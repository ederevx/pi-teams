#!/usr/bin/env python3
"""OOP and module-responsibility lint for pi-teams.

Mechanically enforces the checkable part of the shared conventions on
src/ and extensions/:
- no module-level mutable state (dict/list/set/Map/Set literals or
  calls assigned at module scope), in Python or TypeScript
- no top-level `let`/`var` in TypeScript, no `global` statements, no
  bare except clauses
- one responsibility per file: at most one primary class (more than
  PRIMARY_METHODS methods) per source file, and no file exceeds
  MAX_FILE_LINES, so a responsibility cannot accrete into a monolithic
  single-file program; a thin entry point may hold zero classes and
  compose the responsibility modules

Small auxiliary classes and free functions may share a file. State
ownership, singleton absence, and single-responsibility method cohesion
are reviewed manually; a source scan cannot see them.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# A file that declares more than one substantial class is mixing
# responsibilities. Small value/helper classes do not count.
PRIMARY_METHODS = 5

# A large file is a monolith even when it declares only one class.
# TeamAgent and TeamBroker are the two largest legitimate owners.
MAX_FILE_LINES = 1200

PY_FILES = sorted((ROOT / "src").glob("*.py"))
TS_FILES = sorted((ROOT / "extensions").rglob("*.ts"))

MODULE_MUTABLE = re.compile(
    r"^(?:export\s+)?[A-Za-z_]\w*\s*=\s*(?:\[|\{|(?:dict|list|set)\("
    r"|new\s+(?:Map|Set|WeakMap|WeakSet)\b)"
)
PY_CLASS = re.compile(r"^class\s+(\w+)")
TS_CLASS = re.compile(r"^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)")
PY_METHOD = re.compile(r"^    (?:async\s+)?def\s+\w+")
TS_METHOD = re.compile(
    r"^\t(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+"
    r"|async\s+|get\s+|set\s+)*\w+\s*\("
)


def primary_classes(lines, is_python):
    """Names of classes with more than PRIMARY_METHODS methods, so a file
    can be checked for owning more than one responsibility."""
    class_re = PY_CLASS if is_python else TS_CLASS
    method_re = PY_METHOD if is_python else TS_METHOD
    found = []
    current = None
    methods = 0

    def flush():
        nonlocal current, methods
        if current is not None and methods > PRIMARY_METHODS:
            found.append(current)
        current, methods = None, 0

    for line in lines:
        match = class_re.match(line)
        if match:
            flush()
            current = match.group(1)
            continue
        if current is None:
            continue
        if method_re.match(line):
            methods += 1
        elif line and not line[0].isspace() \
                and not line.startswith(("//", "/*", "*", "#", "@")):
            flush()
    flush()
    return found


def check_file(path):
    problems = []
    lines = path.read_text().splitlines()
    if len(lines) > MAX_FILE_LINES:
        problems.append(
            "%s: %d lines exceeds the %d-line responsibility cap"
            % (path.name, len(lines), MAX_FILE_LINES))
    primaries = primary_classes(lines, path.suffix == ".py")
    if len(primaries) > 1:
        problems.append(
            "%s: declares %d primary classes (%s); split one "
            "responsibility per file"
            % (path.name, len(primaries), ", ".join(primaries)))
    for lineno, line in enumerate(lines, 1):
        if MODULE_MUTABLE.match(line):
            problems.append(
                "%s:%d: module-level mutable state" % (path.name, lineno))
        if re.match(r"^\s*global\s+", line):
            problems.append("%s:%d: global statement" % (path.name, lineno))
        if re.search(r"except\s*:", line):
            problems.append("%s:%d: bare except" % (path.name, lineno))
        if path.suffix != ".py" and re.match(r"^(?:export\s+)?(?:let|var)\s", line):
            problems.append(
                "%s:%d: module-level let/var" % (path.name, lineno))
    return problems


def check():
    problems = []
    for path in PY_FILES + TS_FILES:
        problems.extend(check_file(path))
    for problem in problems:
        print("oop: %s" % problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(check())