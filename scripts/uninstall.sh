#!/usr/bin/env bash
# Remove exactly what scripts/install.sh installed, per the manifest.
set -euo pipefail

state_dir="${PI_TEAMS_STATE_DIR:-$HOME/.local/state/pi-teams}"
manifest="$state_dir/manifest.json"
if [[ ! -f "$manifest" ]]; then
	echo "pi-teams: nothing installed (no manifest at $manifest)"
	exit 0
fi

python_bin="${PYTHON:-}"
if [[ -z "$python_bin" ]]; then
	for candidate in python3 python py; do
		if command -v "$candidate" >/dev/null 2>&1; then
			python_bin="$candidate"
			break
		fi
	done
fi
[[ -n "$python_bin" ]] || {
	echo "pi-teams: no python interpreter found for the manifest" >&2
	exit 1
}

"$python_bin" -c '
import json, sys
manifest = json.load(open(sys.argv[1]))
for path in manifest["files"]:
    print(path, end="\0")
' "$manifest" | xargs -0 -r rm -f

rm -f "$manifest"
echo "pi-teams: uninstalled"