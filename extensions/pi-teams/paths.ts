/**
 * Runtime and package paths and root file writes for the pi-teams
 * extension: where the broker/client live, how the pi runtime is
 * invoked, and the atomic writes under the state root. The TypeScript
 * counterpart of TeamRoot (src/team_root.py).
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { settings } from "./settings.ts";

export const stateRoot = settings.stateDir();
export const binDir = settings.binDir();

/** Where pi writes session transcripts (.jsonl), one directory per
 *  working directory; team_tail reads the newest. */
export const sessionsRoot = settings.sessionsRoot();

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

// An explicitly configured bin dir means a manual install that owns
// its binaries; otherwise the package's bundled src is used.
const bundled = settings.isConfigured("PI_TEAMS_BIN", "binDir")
	? "" : bundledSrcDir();
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

/**
 * The same launch, as environment entries for the Python broker. The
 * broker has no runtime entry in its own argv, so it cannot resolve a
 * pi the way piInvocation does, and a bare `pi` name names no
 * executable on Windows (npm installs only pi.cmd/pi.ps1 shims there).
 */
export function piInvocationEnv(): Record<string, string> {
	const { command, args } = piInvocation();
	if (args.length > 0) {
		return { PI_TEAMS_PI_ENTRY: args[0], PI_TEAMS_PI_NODE: command };
	}
	if (command !== "pi") return { PI_TEAMS_PI_COMMAND: command };
	return {};
}

/** The durable launch record's file name under the state root. The
 *  Python owner of the path and field names is src/pi_invocation.py
 *  (ENTRY_FILE/ENTRY_VERSION and its record/read logic); keep these in
 *  sync. */
export const piEntryFile = "pi-entry.json";
export const piEntryVersion = 1;

/**
 * The launch record for the running runtime, or null when only the
 * bare `pi` name resolved. It mirrors piInvocationEnv: entry/node
 * mirror PI_TEAMS_PI_ENTRY/PI_TEAMS_PI_NODE and command/args mirror
 * PI_TEAMS_PI_COMMAND/PI_TEAMS_PI_ARGS.
 */
function piInvocationRecord() {
	const { command, args } = piInvocation();
	if (args.length > 0) {
		return { version: piEntryVersion, entry: args[0], node: command };
	}
	if (command !== "pi") {
		return { version: piEntryVersion, command, args: [] as string[] };
	}
	return null;
}

/**
 * Persist the launch record under the state root so a broker started
 * without the environment (a pre-v0.4.36 extension) resolves the same
 * runtime. The bare `pi` fallback is never written: it cannot launch
 * on Windows and must not clobber a usable record from an earlier run.
 */
export function persistPiInvocation(): void {
	const record = piInvocationRecord();
	if (!record) return;
	writeStateFile(piEntryFile, JSON.stringify(record) + "\n");
}