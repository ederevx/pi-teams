#!/usr/bin/env python3
"""README format lint for pi-teams.

Checks title, heading structure, 80-column prose wrap (URLs and code
may exceed), no trailing whitespace or tabs, balanced fences, and the
required section set. Mirrors the enforcement used by the sibling
repositories.
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
README = ROOT / "README.md"

REQUIRED_SECTIONS = [
    "## What it provides",
    "## Validation",
    "## Deployment",
    "## Attribution",
    "## License",
]


def fence_balanced(lines):
    count = 0
    for line in lines:
        if line.lstrip().startswith("```"):
            count += 1
    return count % 2 == 0


def check():
    problems = []
    if not README.exists():
        print("readme: missing README.md")
        return 1
    text = README.read_text().splitlines()
    if not text or text[0].strip() != "# pi-teams":
        problems.append("first line must be exactly '# pi-teams'")

    for section in REQUIRED_SECTIONS:
        if section not in text:
            problems.append("missing section %r" % section)

    if not fence_balanced(text):
        problems.append("unbalanced code fences")

    in_fence = False
    for lineno, line in enumerate(text, 1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if line.rstrip() != line:
            problems.append("line %d: trailing whitespace" % lineno)
        if "\t" in line:
            problems.append("line %d: tab character" % lineno)
        if in_fence:
            continue
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith(("http://", "https://", "`", "|")):
            continue
        if len(line) > 80:
            problems.append("line %d: prose exceeds 80 columns" % lineno)

    for problem in problems:
        print("readme: %s" % problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(check())