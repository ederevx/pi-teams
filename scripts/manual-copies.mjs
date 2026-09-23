/**
 * Remove the manual-install copies a prior `scripts/install.sh` left so a
 * pi package install stays the single loader source.
 *
 * pi loads every file under the agent home's extensions dir; a manual
 * copy beside a package install loads the same extension twice and aborts
 * every new session with tool-conflict errors ("Tool "bash" conflicts
 * ..."). The rule mirrors pi-daemon's --package mode: a path goes when
 * the manual manifest owned it, or when it is byte-identical to this
 * clone's counterpart (a copy whose manifest is gone). Unrelated files
 * are never touched.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Whether dest and source are distinct files with identical bytes. */
function sameBytes(dest, source) {
	if (!existsSync(dest) || !existsSync(source)) return false;
	if (!statSync(dest).isFile()) return false;
	return dest !== source
		&& readFileSync(dest).equals(readFileSync(source));
}

function normalized(path) {
	return path.replace(/\\/g, "/");
}

/** One manual-copy rule: a dest path (file or directory) and the clone
 *  counterpart whose bytes identify an unrecorded copy. */
class Candidate {
	constructor(type, dest, source) {
		this.type = type;
		this.dest = dest;
		this.source = source;
	}

	/** Whether this copy must go: the manifest recorded it, or its
	 *  bytes match the clone (a whole directory matches when it holds
	 *  exactly the counterpart's file set, byte for byte). */
	owned(manifestPaths) {
		if (manifestPaths.has(normalized(this.dest))) return true;
		if (!existsSync(this.dest)) return false;
		if (this.type === "file") return sameBytes(this.dest, this.source);
		if (!statSync(this.dest).isDirectory()) return false;
		const names = readdirSync(this.dest).sort();
		const sourceNames = readdirSync(this.source).sort();
		if (JSON.stringify(names) !== JSON.stringify(sourceNames)) return false;
		return names.every((name) =>
			sameBytes(join(this.dest, name), join(this.source, name)));
	}
}

/** Owns the removal of one package's manual-install copies. */
export class ManualCopyCleaner {
	/** @param manifestPath the manual install's manifest.json
	 *  @param candidates {type, dest, source} rules for every path the
	 *   manual installer may have written */
	constructor(manifestPath, candidates) {
		this.manifestPath = manifestPath;
		this.candidates = candidates;
	}

	/** The manifest's recorded paths, or an empty set when absent or
	 *  unreadable: a broken manifest must not widen removal. */
	manifestPaths() {
		try {
			const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8"));
			const paths = parsed.files ?? parsed.owned ?? [];
			return new Set(paths.map((p) => normalized(p)));
		} catch {
			return new Set();
		}
	}

	/** Removes every manual copy this rule owns. Returns the removed
	 *  paths; never throws — a failed removal only skips that path. */
	clean() {
		const manifestPaths = this.manifestPaths();
		const removed = [];
		for (const candidate of this.candidates) {
			try {
				if (!candidate.owned(manifestPaths)) continue;
				rmSync(candidate.dest, { recursive: true, force: true });
				removed.push(candidate.dest);
			} catch {
				// fail-soft: keep the copy rather than abort the install
			}
		}
		return removed;
	}
}

/** Builds pi-teams' candidate table: the extension entry file, the
 *  responsibility-module directory, and every bin helper the manual
 *  installer writes. Package mode covers the bin helpers via the
 *  sibling src/ bundled broker/client, so they go with the copies. */
export function piTeamsCandidates(agentDir, binDir, repoRoot) {
	const candidates = [
		new Candidate("file", join(agentDir, "extensions", "pi-teams.ts"),
			join(repoRoot, "extensions", "pi-teams.ts")),
		new Candidate("dir", join(agentDir, "extensions", "pi-teams"),
			join(repoRoot, "extensions", "pi-teams")),
		new Candidate("file", join(binDir, "peer-ssh-setup"),
			join(repoRoot, "scripts", "peer-ssh-setup.sh")),
	];
	for (const name of ["teamd", "team"]) {
		candidates.push(new Candidate(
			"file", join(binDir, name), join(repoRoot, "src", `${name}.py`)));
	}
	try {
		for (const name of readdirSync(join(repoRoot, "src"))) {
			if (name.endsWith(".py") && name !== "teamd.py" && name !== "team.py") {
				candidates.push(new Candidate(
					"file", join(binDir, name), join(repoRoot, "src", name)));
			}
		}
	} catch {
		// no src/ modules in this checkout shape
	}
	return candidates;
}

/** Default pi-teams locations, honoring the installer's env overrides. */
export function piTeamsPaths(repoRoot) {
	const agentDir = process.env.PI_CODING_AGENT_DIR
		|| join(homedir(), ".pi", "agent");
	const binDir = process.env.PI_TEAMS_BIN_DIR
		|| join(homedir(), ".local", "bin");
	const stateDir = process.env.PI_TEAMS_STATE_DIR
		|| join(homedir(), ".local", "state", "pi-teams");
	return { agentDir, binDir, manifestPath: join(stateDir, "manifest.json") };
}