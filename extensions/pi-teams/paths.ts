/**
 * Runtime and package paths and root file writes for the pi-teams
 * extension: where the broker/client live, how the pi runtime is
 * invoked, and the atomic writes under the state root. The TypeScript
 * counterpart of TeamRoot (src/team_root.py).
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Where pi writes session transcripts (.jsonl), one directory per
 *  working directory; team_tail reads the newest. */
export const sessionsRoot =
	process.env.PI_SESSIONS_ROOT || join(home, ".pi", "agent", "sessions");

/** The bundled broker/client (sibling src/ with teamd.py, team.py)
 *  when loaded from a pi package; PI_TEAMS_BIN wins for manual
 *  installs. */
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

const bundled = process.env.PI_TEAMS_BIN ? "" : bundledSrcDir();
export const teamdBin = bundled ? join(bundled, "teamd.py") : join(binDir, "teamd");
export const teamBin = bundled ? join(bundled, "team.py") : join(binDir, "team");

/** Atomically writes a state-root file: scratch in the same directory,
 *  then rename, so a reader (the hold's heartbeat) never sees a torn
 *  state file; the scratch carries the mode. */
export function writeStateFile(
	relative: string, data: string, mode = 0o644,
): void {
	mkdirSync(stateRoot, { recursive: true });
	const target = join(stateRoot, relative);
	const tmp = `${target}.tmp.${process.pid}`;
	writeFileSync(tmp, data, { mode });
	// A reader holding the destination open can refuse the rename on
	// Windows; retry briefly, then rethrow without leaving scratch.
	for (let attempt = 0; ; attempt += 1) {
		try {
			renameSync(tmp, target);
			return;
		} catch (err) {
			if (attempt >= 10) {
				try {
					unlinkSync(tmp);
				} catch {
					// nothing left to clean
				}
				throw err;
			}
			// Sync pause (sleep without a worker).
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
}

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