/**
 * Runtime and package paths for the pi-teams extension: where the
 * broker/client live and how the running pi runtime is invoked. Path
 * layout is the only responsibility this module owns.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = homedir();

export const stateRoot =
	process.env.TEAM_ROOT ||
	join(process.env.XDG_STATE_HOME || join(home, ".local", "state"),
		"pi-teams");
export const binDir =
	process.env.PI_TEAMS_BIN || join(home, ".local", "bin");

/** The package's bundled broker/client, when this extension is loaded
 *  from a pi package: the sibling src/ holding teamd.py and team.py.
 *  An explicit PI_TEAMS_BIN wins, so a manual install can override it. */
function bundledSrcDir(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const candidate = join(here, "..", "..", "src");
		if (existsSync(join(candidate, "teamd.py"))) return candidate;
	} catch {
		// not loaded as an ES module with a URL
	}
	return "";
}

/** The package's bundled scripts/ (the user-run setup helper), when
 *  loaded from a pi package. An explicit PI_TEAMS_BIN wins. */
function bundledScriptsDir(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const candidate = join(here, "..", "..", "scripts");
		if (existsSync(join(candidate, "peer-ssh-setup.sh"))) {
			return candidate;
		}
	} catch {
		// not loaded as an ES module with a URL
	}
	return "";
}

const bundled = process.env.PI_TEAMS_BIN ? "" : bundledSrcDir();
export const teamdBin = bundled ? join(bundled, "teamd.py") : join(binDir, "teamd");
export const teamBin = bundled ? join(bundled, "team.py") : join(binDir, "team");
const bundledScripts = process.env.PI_TEAMS_BIN ? "" : bundledScriptsDir();
export const peerSetupScript = bundledScripts
	? join(bundledScripts, "peer-ssh-setup.sh")
	: join(binDir, "peer-ssh-setup");

/**
 * How to launch another pi without a shell. Reusing the running runtime
 * avoids spawning a Windows launcher shim (pi.cmd/pi.ps1) directly,
 * which child_process cannot execute; pi's own subagent helper resolves
 * it the same way. This is the only launch path for teammates.
 */
export function piInvocation(): { command: string; args: string[] } {
	const entry = process.argv[1];
	if (entry && existsSync(entry) && !entry.startsWith("/$bunfs/root/")) {
		return { command: process.execPath, args: [entry] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args: [] };
	}
	return { command: "pi", args: [] };
}