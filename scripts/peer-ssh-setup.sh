#!/usr/bin/env sh
# One-time SSH setup for a password-only pi-teams peer.
#
# pi-teams reaches a peer broker with plain, non-interactive ssh: it has
# no TTY to answer a password prompt or confirm a host key, so a host
# that needs a password fails until a key is installed once. Run this in
# a terminal; it prompts for the target password exactly once, then
# leaves no temporary files behind.
#
#   sh peer-ssh-setup.sh [-p PORT] [-i KEY] user@host
#
# After it prints "ready", retry: team_peer add <ssh-host>

set -eu

port=""
identity=""
dry_run=0
target=""
scratch=""
SSH_OPTS=""

usage() {
	cat <<'EOF'
Usage: peer-ssh-setup.sh [options] user@host

Make a password-only SSH peer usable by pi-teams.

Options:
  -p, --port PORT    ssh port (otherwise ~/.ssh/config applies)
  -i, --identity F   private key to use or create
  -n, --dry-run      show the commands, change nothing
  -h, --help         show this help

Run this once in a terminal; it prompts for the target password only.
It writes a key and a known_hosts entry and leaves no other files.
EOF
}

die() {
	printf 'peer-ssh-setup: %s\n' "$*" >&2
	exit 1
}

# Every state change goes through here, so --dry-run cannot mutate.
run() {
	if [ "$dry_run" -eq 1 ]; then
		printf '+ %s\n' "$*"
		return 0
	fi
	"$@"
}

parse_args() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
			-p|--port)
				[ "$#" -ge 2 ] || die "-p needs a port"
				port="$2"; shift 2 ;;
			-i|--identity)
				[ "$#" -ge 2 ] || die "-i needs a file"
				identity="$2"; shift 2 ;;
			-n|--dry-run) dry_run=1; shift ;;
			-h|--help) usage; exit 0 ;;
			--) shift; break ;;
			-*) die "unknown option: $1" ;;
			*) break ;;
		esac
	done
	target="${1:-}"
	[ -n "$target" ] || { usage >&2; die "missing user@host"; }
}

# The ssh flags shared by every call. accept-new trusts an unseen host
# key once and refuses a changed one, so the only prompt is the password.
build_ssh_opts() {
	SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
	if [ -n "$port" ]; then
		SSH_OPTS="$SSH_OPTS -p $port"
	fi
}

# A scratch directory under the user's tmp root; the trap reaps it even
# on interrupt, so a failed or cancelled run leaves nothing behind.
prepare_scratch() {
	base="${TMPDIR:-$HOME/tmp}"
	scratch="$base/peer-ssh-setup.$$"
	if [ "$dry_run" -eq 1 ]; then
		return 0
	fi
	mkdir -p "$base" "$scratch"
	chmod 700 "$scratch" 2>/dev/null || true
	trap 'rm -rf "$scratch"' EXIT INT TERM HUP
}

resolve_identity() {
	if [ -n "$identity" ]; then
		return 0
	fi
	for candidate in "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa"; do
		if [ -f "$candidate" ]; then
			identity="$candidate"
			return 0
		fi
	done
	identity="$HOME/.ssh/id_ed25519"
}

# An empty passphrase keeps the later BatchMode calls prompt-free.
ensure_identity() {
	if [ "$dry_run" -eq 1 ]; then
		if [ ! -f "$identity" ]; then
			printf '+ ssh-keygen -t ed25519 -N "" -C pi-teams -f %s\n' "$identity"
		fi
		if [ ! -f "$identity.pub" ]; then
			printf '+ ssh-keygen -y -f %s > %s.pub\n' "$identity" "$identity"
		fi
		return 0
	fi
	mkdir -p "$HOME/.ssh"
	chmod 700 "$HOME/.ssh" 2>/dev/null || true
	if [ ! -f "$identity" ]; then
		run ssh-keygen -t ed25519 -N "" -C "pi-teams" -f "$identity"
	fi
	if [ ! -f "$identity.pub" ]; then
		ssh-keygen -y -f "$identity" > "$identity.pub"
	fi
}

# Git Bash's native ssh may carry a CRLF key due to Windows tooling; a
# stray carriage return silently breaks auth. Copy it clean for install.
clean_public_key() {
	clean="$scratch/pub.clean"
	if [ "$dry_run" -eq 1 ]; then
		printf '+ tr -d "\\r" < %s.pub > %s\n' "$identity" "$clean"
		return 0
	fi
	tr -d '\r' < "$identity.pub" > "$clean"
}

# accept-new records an unseen host key even though auth has no key yet;
# the expected auth failure is ignored, and a changed key still fails.
trust_host() {
	if [ "$dry_run" -eq 1 ]; then
		printf '+ ssh %s -o BatchMode=yes %s true\n' "$SSH_OPTS" "$target"
		return 0
	fi
	ssh $SSH_OPTS -o BatchMode=yes "$target" true 2>/dev/null || true
}

install_key() {
	if command -v ssh-copy-id >/dev/null 2>&1; then
		if [ -n "$port" ]; then
			run ssh-copy-id -i "$clean" -p "$port" "$target"
		else
			run ssh-copy-id -i "$clean" "$target"
		fi
		return 0
	fi
	# Windows' built-in OpenSSH ships no ssh-copy-id; append the key the
	# way ssh-copy-id's own installer does.
	if [ "$dry_run" -eq 1 ]; then
		printf '+ ssh %s %s '\''umask 077; mkdir -p ~/.ssh; ' "$SSH_OPTS" "$target"
		printf 'chmod 700 ~/.ssh; cat >> ~/.ssh/authorized_keys; '
		printf 'chmod 600 ~/.ssh/authorized_keys'\'' < %s\n' "$clean"
		return 0
	fi
	ssh $SSH_OPTS "$target" \
		'umask 077; mkdir -p ~/.ssh; chmod 700 ~/.ssh; cat >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys' \
		< "$clean"
}

# The exact non-interactive path pi-teams uses: no TTY, no prompts.
verify_key() {
	run ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$identity" \
		$SSH_OPTS "$target" 'echo pi-teams-setup-ok'
}

main() {
	parse_args "$@"
	build_ssh_opts
	prepare_scratch
	resolve_identity
	ensure_identity
	clean_public_key
	trust_host
	install_key
	verify_key
	if [ "$dry_run" -eq 1 ]; then
		printf '(dry run: nothing changed)\n'
		return 0
	fi
	printf 'peer-ssh-setup: %s is ready for pi-teams\n' "$target"
}

main "$@"