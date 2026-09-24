/**
 * pi-teams - settings persistence.
 *
 * One responsibility: read and atomically write the `piTeams` namespace
 * of pi's agent-directory settings file. A corrupt file is never
 * overwritten: the write fails and the caller reports it. The agent
 * directory is resolved at call time, not at construction, so a test or
 * embedder can redirect `PI_CODING_AGENT_DIR`.
 */

import {
	chmodSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const NAMESPACE = "piTeams";

export class SettingsStore {
	/** The settings file: `PI_CODING_AGENT_DIR` (read now) or the
	 *  default agent directory. */
	path(): string {
		const root = process.env.PI_CODING_AGENT_DIR
			|| join(homedir(), ".pi", "agent");
		return join(root, "settings.json");
	}

	/** The whole settings object, or an empty one when the file is
	 *  absent. A file that exists but cannot be parsed as a JSON object
	 *  is corrupt and reported, never silently replaced. */
	load(): Record<string, unknown> {
		const file = this.path();
		if (!existsSync(file)) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			throw new Error(`${file} is not valid JSON; refusing to overwrite it`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(
				`${file} is not a JSON object; refusing to overwrite it`);
		}
		return parsed as Record<string, unknown>;
	}

	/** The `piTeams` namespace of a loaded settings object, empty when
	 *  absent. A namespace that is present but not an object is corrupt
	 *  too: replacing it would discard whatever it holds. */
	namespace(settings: Record<string, unknown>): Record<string, unknown> {
		const current = settings[NAMESPACE];
		if (current === undefined || current === null) return {};
		if (typeof current !== "object" || Array.isArray(current)) {
			throw new Error(
				`${this.path()}: the ${NAMESPACE} value is not an object; ` +
				"refusing to overwrite it");
		}
		return current as Record<string, unknown>;
	}

	/** Sets one key inside the `piTeams` namespace, preserving every
	 *  other key and the file mode, and writes through a temp file in
	 *  the target directory. Throws when the file is corrupt or the
	 *  write fails. */
	set(key: string, value: unknown): void {
		const settings = this.load();
		settings[NAMESPACE] = { ...this.namespace(settings), [key]: value };
		this.write(this.path(), settings);
	}

	/** The scratch-pad write: a temp file beside the target, the
	 *  original's mode preserved, then moved over it. */
	private write(file: string, settings: Record<string, unknown>): void {
		const tmp = join(dirname(file), `settings.json.tmp-${process.pid}`);
		const mode = existsSync(file) ? statSync(file).mode : undefined;
		writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
		if (mode !== undefined) chmodSync(tmp, mode);
		try {
			renameSync(tmp, file);
		} catch {
			// Windows cannot rename over an existing file.
			if (existsSync(file)) unlinkSync(file);
			renameSync(tmp, file);
		}
	}
}
