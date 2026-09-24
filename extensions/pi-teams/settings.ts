/**
 * Package settings for pi-teams: the single owner of the `piTeams`
 * namespace in pi's agent-directory `settings.json`, with typed
 * accessors and environment precedence (explicit non-empty env, then a
 * valid settings value, then the built-in default). Nothing about the
 * broker or the wire protocol belongs here.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export type SettingsKind = "number" | "bool" | "text" | "path";

/** How often an active team_wait re-checks, and the fallback bounds
 *  when no env variable or settings value applies. */
export const DEFAULT_WAIT_SECONDS = 300;
export const DEFAULT_STALL_SECONDS = 90;
export const DEFAULT_SPAWN_WINDOW_MS = 15000;

export class PackageSettings {
	private readonly env: Record<string, string | undefined>;
	private readonly agentDir: string;
	private namespace: Record<string, unknown> | undefined;

	constructor(
		env: Record<string, string | undefined> = process.env,
		agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
	) {
		this.env = env;
		this.agentDir = agentDir;
	}

	/** The `piTeams` namespace, or an empty object when the settings
	 *  file is missing, unreadable, malformed, or not an object. */
	private load(): Record<string, unknown> {
		if (this.namespace !== undefined) return this.namespace;
		this.namespace = {};
		const file = join(this.agentDir, "settings.json");
		if (!existsSync(file)) return this.namespace;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
				string, unknown
			>;
			const teams = parsed?.piTeams;
			if (teams && typeof teams === "object" && !Array.isArray(teams)) {
				this.namespace = teams as Record<string, unknown>;
			}
		} catch {
			// A broken settings file is tolerated; defaults apply.
		}
		return this.namespace;
	}

	/** Precedence: explicit non-empty env, then a valid settings value,
	 *  then the fallback. `envName` may list variables in priority
	 *  order. */
	resolve(
		envName: string | string[],
		key: string,
		fallback: unknown,
		kind: SettingsKind,
	): unknown {
		const names = typeof envName === "string" ? [envName] : envName;
		for (const name of names) {
			const raw = this.env[name];
			if (raw === undefined || raw === "") continue;
			const value = this.coerce(raw, kind);
			if (value !== undefined) return value;
		}
		const raw = this.load()[key];
		if (raw !== undefined && raw !== null) {
			const value = this.coerce(raw, kind);
			if (value !== undefined) return value;
		}
		return fallback;
	}

	private coerce(raw: unknown, kind: SettingsKind): unknown {
		// A number is finite and at or above zero, so 0 is a real value
		// (an immediate reap, a disabled warning) and not "unset".
		if (kind === "number") {
			if (typeof raw === "boolean"
				|| (typeof raw === "object" && raw !== null)) {
				return undefined;
			}
			const text = String(raw).trim();
			if (text === "") return undefined;
			const value = Number(text);
			return Number.isFinite(value) && value >= 0 ? value : undefined;
		}
		if (kind === "bool") {
			if (typeof raw === "boolean") return raw;
			const text = String(raw).trim().toLowerCase();
			if (["1", "true", "yes", "on"].includes(text)) return true;
			if (["0", "false", "no", "off"].includes(text)) return false;
			return undefined;
		}
		if (typeof raw !== "string" || raw === "") return undefined;
		if (kind === "path") return raw.replace(/^~(?=$|[\\/])/, homedir());
		return raw;
	}

	/** Whether an env variable or settings key was explicitly set; a
	 *  flag whose mere presence selects a mode needs the distinction
	 *  between "configured" and the built-in default. */
	isConfigured(envName: string, key: string): boolean {
		if (this.env[envName]) return true;
		const raw = this.load()[key];
		return raw !== undefined && raw !== null && raw !== "";
	}

	host(): string {
		return (this.resolve("PI_TEAMS_HOST", "host", "", "text") as string)
			|| hostname().split(".")[0];
	}

	stateDir(): string {
		return (this.resolve("TEAM_ROOT", "stateDir", "", "path") as string)
			|| join(
				this.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
				"pi-teams",
			);
	}

	binDir(): string {
		return (this.resolve("PI_TEAMS_BIN", "binDir", "", "path") as string)
			|| join(homedir(), ".local", "bin");
	}

	sessionsRoot(): string {
		// PI_SESSIONS_ROOT stays a legacy fallback for the extension's
		// old variable name.
		const explicit = this.resolve(
			["PI_TEAMS_SESSIONS_ROOT", "PI_SESSIONS_ROOT"],
			"sessionsRoot", "", "path") as string;
		return explicit || join(this.agentDir, "sessions");
	}

	forkIdleSeconds(): number {
		return this.resolve(
			"PI_TEAMS_FORK_IDLE", "forkIdleSeconds", 300, "number") as number;
	}

	busyGraceSeconds(): number {
		return this.resolve(
			"PI_TEAMS_BUSY_GRACE", "busyGraceSeconds", 120,
			"number") as number;
	}

	gcWarnGraceSeconds(): number {
		// The legacy variable stays read after the current one; both
		// are environment overrides and precede the settings value.
		return this.resolve(
			["PI_TEAMS_GC_WARN_GRACE", "PI_TEAMS_GC_PING_GRACE"],
			"gcWarnGraceSeconds", 60, "number") as number;
	}

	restartGraceSeconds(): number {
		return this.resolve(
			"PI_TEAMS_RESTART_GRACE", "restartGraceSeconds", 60,
			"number") as number;
	}

	peerGraceSeconds(): number {
		return this.resolve(
			"PI_TEAMS_PEER_GRACE", "peerGraceSeconds", 15,
			"number") as number;
	}

	sessionGraceSeconds(): number {
		return this.resolve(
			"PI_TEAMS_SESSION_GRACE", "sessionGraceSeconds", 3600,
			"number") as number;
	}

	sessionSweepIntervalSeconds(): number {
		return this.resolve(
			"PI_TEAMS_SESSION_SWEEP_INTERVAL", "sessionSweepIntervalSeconds",
			300, "number") as number;
	}

	/** A zero or negative answer window is no window at all, so the
	 *  default stands in (the call site needs a positive timeout). */
	spawnWindowMs(): number {
		const value = this.resolve(
			"PI_TEAMS_SPAWN_WINDOW", "spawnWindowMs",
			DEFAULT_SPAWN_WINDOW_MS, "number") as number;
		return value > 0 ? value : DEFAULT_SPAWN_WINDOW_MS;
	}

	/** Zero is not a wait bound; the default stands in. */
	waitSeconds(): number {
		const value = this.resolve(
			"PI_TEAMS_WAIT", "waitSeconds",
			DEFAULT_WAIT_SECONDS, "number") as number;
		return value > 0 ? value : DEFAULT_WAIT_SECONDS;
	}

	/** Zero disables the stall nudge and is a real value. */
	stallSeconds(): number {
		return this.resolve(
			"PI_TEAMS_STALL", "stallSeconds",
			DEFAULT_STALL_SECONDS, "number") as number;
	}

	ssh(): string {
		return this.resolve("PI_TEAMS_SSH", "ssh", "ssh", "text") as string;
	}

	remoteState(): string | null {
		return (this.resolve(
			"PI_TEAMS_REMOTE_STATE", "remoteState", "", "text") as string)
			|| null;
	}

	peerSetup(): string | null {
		return (this.resolve(
			"PI_TEAMS_PEER_SETUP", "peerSetup", "", "text") as string)
			|| null;
	}
}

/** The process-wide settings owner. */
export const settings = new PackageSettings();
