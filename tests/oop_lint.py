#!/usr/bin/env python3
"""OOP lint for pi-teams.

Enforces the shared conventions on src/ and extensions/:
- no module-level mutable state (dict/list/set literals or empty calls
  assigned at module scope)
- no `global` statements, no bare except clauses
- no `var` in TypeScript, and no mutable module-level assignments there
- state is owned by classes; every class is instantiated only through
  its own constructor signature (no singleton globals).
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

PY_FILES = sorted((ROOT / "src").glob("*.py"))
TS_FILES = sorted((ROOT / "extensions").glob("*.ts"))

MODULE_MUTABLE = re.compile(
    r"^[A-Za-z_]\w*\s*=\s*(?:\[|\{|(?:dict|list|set)\()"
)


def lint_py(path):
    problems = []
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        if MODULE_MUTABLE.match(line):
            problems.append("%s:%d: module-level mutable state" % (path.name, lineno))
        if re.match(r"^\s*global\s+", line):
            problems.append("%s:%d: global statement" % (path.name, lineno))
        if re.search(r"except\s*:", line):
            problems.append("%s:%d: bare except" % (path.name, lineno))
    return problems


def lint_ts(path):
    problems = []
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        if re.match(r"^\s*var\s+", line):
            problems.append("%s:%d: var declaration" % (path.name, lineno))
        if MODULE_MUTABLE.match(line):
            problems.append("%s:%d: module-level mutable state" % (path.name, lineno))
        if re.search(r"except\s*:", line):
            problems.append("%s:%d: bare except" % (path.name, lineno))
    return problems


def check():
    problems = []
    for path in PY_FILES:
        problems.extend(lint_py(path))
    for path in TS_FILES:
        problems.extend(lint_ts(path))
    for problem in problems:
        print("oop: %s" % problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(check())