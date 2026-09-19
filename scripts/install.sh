#!/usr/bin/env bash
# Install the pi-teams broker, client, and pi extension.
#
# Copies src/teamd.py and src/team.py into $HOME/.local/bin and the
# extension into the pi agent home extensions dir. Every copy is staged
# to a same-directory temp file and moved over the destination, so
# readers never see a partial file. A manifest records installed bytes;
# uninstall.sh removes exactly what this installed.
set -euo pipefail
IFS=$'\n'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
bin_dir="${PI_TEAMS_BIN_DIR:-$HOME/.local/bin}"
state_dir="${PI_TEAMS_STATE_DIR:-$HOME/.local/state/pi-teams}"
manifest="$state_dir/manifest.json"

mkdir -p "$bin_dir" "$agent_dir/extensions" "$(dirname "$manifest")"

install_script() {
	local source_file="$1" dest="$2"
	local tmp="$dest.tmp.$$"
	install -m 755 "$source_file" "$tmp"
	mv -f "$tmp" "$dest"
	echo "installed $(basename "$dest")"
}

install_script "$repo_root/src/teamd.py" "$bin_dir/teamd"
install_script "$repo_root/src/team.py" "$bin_dir/team"
install_script "$repo_root/extensions/pi-teams.ts" "$agent_dir/extensions/pi-teams.ts"

cat > "$manifest.tmp.$$" <<EOF
{
  "bin_dir": "$bin_dir",
  "agent_dir": "$agent_dir",
  "files": [
    "$bin_dir/teamd",
    "$bin_dir/team",
    "$agent_dir/extensions/pi-teams.ts"
  ]
}
EOF
mv -f "$manifest.tmp.$$" "$manifest"

echo "pi-teams installed. Restart pi sessions so the extension loads;"
echo "the broker starts on first /team use or session start."