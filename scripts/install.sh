#!/usr/bin/env bash
# Install the pi-teams broker, client, and pi extension.
#
# Copies every src/*.py into $HOME/.local/bin (teamd.py and team.py as
# the executable `teamd`/`team`, the rest as importable modules), copies
# the extension entry file into the pi agent home extensions dir plus the
# responsibility-module directory beside it, and records installed bytes
# in a manifest. Every file is staged to a same-directory temp file and
# moved over the destination, so readers never see a partial file.
# uninstall.sh removes exactly what this installed.
set -euo pipefail
IFS=$'\n'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
bin_dir="${PI_TEAMS_BIN_DIR:-$HOME/.local/bin}"
state_dir="${PI_TEAMS_STATE_DIR:-$HOME/.local/state/pi-teams}"
manifest="$state_dir/manifest.json"

mkdir -p "$bin_dir" "$agent_dir/extensions" "$(dirname "$manifest")"

files=()

install_file() {
	local source_file="$1" dest="$2" mode="$3"
	local tmp="$dest.tmp.$$"
	install -m "$mode" "$source_file" "$tmp"
	mv -f "$tmp" "$dest"
	echo "installed $(basename "$dest")"
	files+=("$dest")
}

# Broker, client, and their importable modules.
for source_file in "$repo_root"/src/*.py; do
	name="$(basename "$source_file")"
	case "$name" in
		teamd.py) install_file "$source_file" "$bin_dir/teamd" 755 ;;
		team.py) install_file "$source_file" "$bin_dir/team" 755 ;;
		*) install_file "$source_file" "$bin_dir/$name" 644 ;;
	esac
done

install_file "$repo_root/scripts/peer-ssh-setup.sh" \
	"$bin_dir/peer-ssh-setup" 755

# Extension entry file, then the responsibility-module directory. The
# directory is staged whole and swapped in, so a loader never sees a
# half-updated module set.
install_file "$repo_root/extensions/pi-teams.ts" \
	"$agent_dir/extensions/pi-teams.ts" 644
ext_dir="$agent_dir/extensions/pi-teams"
stage="${ext_dir}.new.$$"
rm -rf "$stage"
mkdir -p "$stage"
cp -p "$repo_root"/extensions/pi-teams/*.ts "$stage/"
if [[ -d "$ext_dir" ]]; then
	old="${ext_dir}.old.$$"
	mv -f "$ext_dir" "$old"
	mv -f "$stage" "$ext_dir"
	rm -rf "$old"
else
	mv -f "$stage" "$ext_dir"
fi
echo "installed extensions/pi-teams/"
files+=("$ext_dir")

{
	printf '{\n'
	printf '  "bin_dir": "%s",\n' "$bin_dir"
	printf '  "agent_dir": "%s",\n' "$agent_dir"
	printf '  "files": [\n'
	first=1
	for path in "${files[@]}"; do
		[[ $first -eq 1 ]] || printf ',\n'
		first=0
		printf '    "%s"' "$path"
	done
	printf '\n  ]\n}\n'
} > "$manifest.tmp.$$"
mv -f "$manifest.tmp.$$" "$manifest"

echo "pi-teams installed. Restart pi sessions so the extension loads;"
echo "the broker starts on first /team use or session start."