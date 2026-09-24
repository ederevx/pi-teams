/**
 * pi-teams - settings presenter.
 *
 * One responsibility: describe every `piTeams` setting as an ordered row
 * carrying its effective value and an editor, then present those rows in
 * pi's two-column settings view (TUI) or as a stderr listing. Accepted
 * changes are persisted through SettingsStore and reported to the user;
 * validation keeps an invalid number from ever reaching the file.
 */

import type { Component } from "@earendil-works/pi-tui";
import {
	ExtensionInputComponent,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import { PackageSettings } from "./settings.ts";
import { SettingsStore } from "./settings-store.ts";
import { TeamSettingsView } from "./settings-view.ts";

export type SettingKind = "number" | "text" | "path";

/** The subset of pi's Theme the view styles with. */
export interface ViewTheme {
	fg(color: "accent" | "muted" | "dim" | "border", text: string): string;
}

/** One editable row: its display value plus either a value cycle or an
 *  input submenu the list opens on Enter. */
export interface SettingRow {
	id: string;
	title: string;
	description: string;
	value: string;
	values?: string[];
	submenu?: (currentValue: string, done: (value?: string) => void) =>
		Component;
}

/** Reports a value the list accepted for a row. */
export type SettingsChange = (id: string, value: string) => void;

/** Reports a validation or render message; errors are notified. */
type Notify = (message: string) => void;

/** Everything needed to build and persist one row. */
interface SettingSpec {
	id: string;
	label: string;
	description: string;
	key: string;
	kind: SettingKind;
	env: string[];
	value: string;
}

/** Parses one raw input; a failure carries the message to show. */
type Parsed = { value: unknown } | { error: string };

export class TeamSettingsPresenter {
	private readonly settings: PackageSettings;
	private readonly store: SettingsStore;
	private readonly env: Record<string, string | undefined>;

	constructor(
		settings: PackageSettings = new PackageSettings(),
		store: SettingsStore = new SettingsStore(),
		env: Record<string, string | undefined> = process.env,
	) {
		this.settings = settings;
		this.store = store;
		this.env = env;
	}

	/** Every `piTeams` setting, in settings-pane order: the seven the
	 *  extension owns, then the ten the broker reads at start. Values
	 *  are the effective ones (env beats file beats default), read now. */
	private specs(): SettingSpec[] {
		const s = this.settings;
		const text = (value: string | null): string => value ?? "";
		return [
			{
				id: "spawnWindowMs", label: "Spawn window", kind: "number",
				key: "spawnWindowMs", env: ["PI_TEAMS_SPAWN_WINDOW"],
				description: "How long a local spawn waits for a broker " +
					"answer, in milliseconds.",
				value: String(s.spawnWindowMs()),
			},
			{
				id: "waitSeconds", label: "Wait timeout", kind: "number",
				key: "waitSeconds", env: ["PI_TEAMS_WAIT"],
				description: "Default team_wait bound when no timeout is " +
					"given, in seconds.",
				value: String(s.waitSeconds()),
			},
			{
				id: "stallSeconds", label: "Stall nudge", kind: "number",
				key: "stallSeconds", env: ["PI_TEAMS_STALL"],
				description: "Silence before team_wait nudges a teammate; " +
					"0 disables the nudge.",
				value: String(s.stallSeconds()),
			},
			{
				id: "binDir", label: "Bin dir", kind: "path",
				key: "binDir", env: ["PI_TEAMS_BIN"],
				description: "Directory holding the team CLI the extension " +
					"launches.",
				value: s.binDir(),
			},
			{
				id: "ssh", label: "SSH binary", kind: "text",
				key: "ssh", env: ["PI_TEAMS_SSH"],
				description: "SSH binary used for peer links.",
				value: s.ssh(),
			},
			{
				id: "remoteState", label: "Remote state dir", kind: "text",
				key: "remoteState", env: ["PI_TEAMS_REMOTE_STATE"],
				description: "State directory used on a peer host; empty " +
					"uses that host's default.",
				value: text(s.remoteState()),
			},
			{
				id: "sessionsRoot", label: "Sessions root", kind: "path",
				key: "sessionsRoot",
				env: ["PI_TEAMS_SESSIONS_ROOT", "PI_SESSIONS_ROOT"],
				description: "Root of pi session transcripts for team_tail " +
					"and session GC.",
				value: s.sessionsRoot(),
			},
			{
				id: "host", label: "Host label", kind: "text",
				key: "host", env: ["PI_TEAMS_HOST"],
				description: "Label this machine advertises to peers.",
				value: s.host(),
			},
			{
				id: "stateDir", label: "State dir", kind: "path",
				key: "stateDir", env: ["TEAM_ROOT"],
				description: "Broker state root: endpoints, registry, " +
					"mailboxes.",
				value: s.stateDir(),
			},
			{
				id: "forkIdleSeconds", label: "Fork idle", kind: "number",
				key: "forkIdleSeconds", env: ["PI_TEAMS_FORK_IDLE"],
				description: "Work-idle seconds before the broker warns a " +
					"fork; 0 disables fork-idle GC.",
				value: String(s.forkIdleSeconds()),
			},
			{
				id: "busyGraceSeconds", label: "Busy grace", kind: "number",
				key: "busyGraceSeconds", env: ["PI_TEAMS_BUSY_GRACE"],
				description: "Seconds a stale .busy file may outlive its " +
					"agent.",
				value: String(s.busyGraceSeconds()),
			},
			{
				id: "gcWarnGraceSeconds", label: "GC warning grace",
				kind: "number", key: "gcWarnGraceSeconds",
				env: ["PI_TEAMS_GC_WARN_GRACE", "PI_TEAMS_GC_PING_GRACE"],
				description: "Seconds a fork has to answer an idle warning " +
					"before it is reaped.",
				value: String(s.gcWarnGraceSeconds()),
			},
			{
				id: "restartGraceSeconds", label: "Restart grace",
				kind: "number", key: "restartGraceSeconds",
				env: ["PI_TEAMS_RESTART_GRACE"],
				description: "Idle seconds before the broker adopts " +
					"changed source.",
				value: String(s.restartGraceSeconds()),
			},
			{
				id: "peerGraceSeconds", label: "Peer grace", kind: "number",
				key: "peerGraceSeconds", env: ["PI_TEAMS_PEER_GRACE"],
				description: "Seconds a peer hold may stay silent before " +
					"the link is dropped.",
				value: String(s.peerGraceSeconds()),
			},
			{
				id: "sessionGraceSeconds", label: "Session grace",
				kind: "number", key: "sessionGraceSeconds",
				env: ["PI_TEAMS_SESSION_GRACE"],
				description: "Age past which a dead teammate's transcript " +
					"is deleted, in seconds.",
				value: String(s.sessionGraceSeconds()),
			},
			{
				id: "sessionSweepIntervalSeconds",
				label: "Session sweep interval", kind: "number",
				key: "sessionSweepIntervalSeconds",
				env: ["PI_TEAMS_SESSION_SWEEP_INTERVAL"],
				description: "Seconds between disk sweeps; must stay " +
					"positive.",
				value: String(s.sessionSweepIntervalSeconds()),
			},
			{
				id: "peerSetup", label: "Peer setup command", kind: "text",
				key: "peerSetup", env: ["PI_TEAMS_PEER_SETUP"],
				description: "Command a user runs once to set up SSH for a " +
					"peer; empty uses the bundled script.",
				value: text(s.peerSetup()),
			},
		];
	}

	/** The rows, in order, from the effective settings. A row whose
	 *  environment variable is set carries a marker so the user sees why
	 *  an edit would not stick across restarts. `notify` reports invalid
	 *  input while the submenu is still open. */
	rows(notify: Notify = () => {}): SettingRow[] {
		return this.specs().map((spec) => ({
			id: spec.id,
			title: this.envPinned(spec) ? `${spec.label} (env-pinned)` : spec.label,
			description: spec.description,
			value: spec.value,
			submenu: (currentValue: string, done: (value?: string) => void) =>
				this.inputFor(spec, currentValue, done, notify),
		}));
	}

	/** Present the rows: the two-column settings view when a TUI custom
	 *  UI is available, else the same rows on stderr. A render failure
	 *  falls back to the listing so the command never breaks a session. */
	async present(
		ui: ExtensionUIContext | undefined,
		mode: string | undefined,
		onChange: SettingsChange,
	): Promise<void> {
		const notify: Notify = (message) => ui?.notify?.(message, "error");
		const rows = this.rows(notify);
		if (mode === "tui" && typeof ui?.custom === "function") {
			try {
				await ui.custom((_tui, theme, _keybindings, done) =>
					new TeamSettingsView(rows, theme, onChange, () => done(undefined)),
				);
				return;
			} catch {
				// fall through to the stderr listing
			}
		}
		this.printRows(rows);
	}

	/** The change callback the command wires into `present`: persist an
	 *  accepted value, then report the outcome. */
	changeHandler(ui: ExtensionUIContext | undefined): SettingsChange {
		return (id, value) => this.apply(id, value, ui);
	}

	/** Persist one accepted value and tell the user. An invalid value is
	 *  notified and never reaches the file; a write failure is reported
	 *  instead of thrown. */
	apply(id: string, value: string, ui?: ExtensionUIContext): void {
		const spec = this.specs().find((candidate) => candidate.id === id);
		if (!spec) return;
		const parsed = this.parse(spec.kind, value);
		if ("error" in parsed) {
			ui?.notify?.(parsed.error, "error");
			return;
		}
		try {
			this.store.set(spec.key, parsed.value);
			ui?.notify?.(
				`Saved ${spec.label}. pi reloads extensions when ` +
				"settings.json changes; broker-owned values apply on the " +
				"next broker restart.",
				"info");
		} catch (err) {
			ui?.notify?.(
				`Could not save ${spec.label}: ${this.message(err)}`, "error");
		}
	}

	/** The submenu editor for one row: an input seeded with the current
	 *  value that validates on submit and keeps the prompt open when the
	 *  value is rejected. */
	private inputFor(
		spec: SettingSpec,
		currentValue: string,
		done: (value?: string) => void,
		notify: Notify,
	): Component {
		return new ExtensionInputComponent(
			spec.label,
			spec.description,
			(raw) => {
				const parsed = this.parse(spec.kind, raw);
				if ("error" in parsed) {
					notify(parsed.error);
					return;
				}
				done(String(parsed.value));
			},
			() => done(),
			{ initialValue: currentValue },
		);
	}

	/** One raw input as the stored value: a number is finite and at or
	 *  above zero, so 0 stays a real value; text and paths pass through
	 *  unchanged (empty clears an optional setting). */
	private parse(kind: SettingKind, raw: string): Parsed {
		if (kind !== "number") return { value: raw };
		const text = raw.trim();
		const value = Number(text);
		if (text === "" || !Number.isFinite(value) || value < 0) {
			return { error: "Enter a number at or above 0." };
		}
		return { value };
	}

	/** Whether any environment variable for this row is set non-empty;
	 *  a pinned row's edits are overridden at every read. */
	private envPinned(spec: SettingSpec): boolean {
		return spec.env.some((name) => {
			const value = this.env[name];
			return value !== undefined && value !== "";
		});
	}

	/** Print the same rows to stderr for non-UI modes. */
	private printRows(rows: SettingRow[]): void {
		console.error(
			"pi-teams-settings:\n  " +
			rows.map((row) => this.formatRow(row)).join("\n  "));
	}

	/** One row in the fallback listing's single-line layout. */
	private formatRow(row: SettingRow): string {
		const shown = row.value === "" ? "(empty)" : row.value;
		return `${row.title}: ${row.description} — current: ${shown}`;
	}

	/** A thrown value as a message. */
	private message(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}
}
