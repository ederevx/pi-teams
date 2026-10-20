/**
 * pi-teams - the remote-work guard.
 *
 * One responsibility: refuse a shell command that reaches another host to
 * do work outside this agent's domain. Coordination goes through
 * pi-teams (team_peer/team_spawn/team_send/team_wait); moving files stays
 * allowed. It reads the command only and never runs it.
 *
 * The guard is a `tool_call` handler, so it also covers nested calls
 * (another tool issuing `bash` with `ctx.executeTool`) and stays active
 * with command offloading disabled. `PI_TEAMS_REMOTE_GUARD=off` or
 * `piTeams.remoteGuard=false` disables it.
 */

import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import {
	RemoteWorkClassifier,
	type RemoteVerdict,
} from "./remote-work-classifier.ts";
import { PackageSettings } from "./settings.ts";

/** Owns the pi-teams verdict policy and the refusal text. */
export class TeamsRemoteGuard {
	/** Verdicts pi-teams refuses: a remote shell, remote work, a tunnel
	 *  (team_peer owns tunnels), and any agent run that is not a pi
	 *  management subcommand. */
	static readonly BLOCKED: ReadonlySet<RemoteVerdict> = new Set([
		"ssh-shell", "ssh-exec", "ssh-tunnel", "headless-pi",
	]);

	private readonly settings: Pick<PackageSettings, "remoteGuard">;
	private readonly classifier: RemoteWorkClassifier;

	constructor(
		settings: Pick<PackageSettings, "remoteGuard"> = new PackageSettings(),
		classifier: RemoteWorkClassifier = new RemoteWorkClassifier(),
	) {
		this.settings = settings;
		this.classifier = classifier;
	}

	register(pi: ExtensionAPI): void {
		pi.on("tool_call", (event) => this.gate(event));
	}

	/** Block the call when the command is remote work. */
	gate(event: ToolCallEvent): ToolCallEventResult | undefined {
		if (!this.settings.remoteGuard()) return undefined;
		const command = this.commandOf(event);
		if (command === undefined) return undefined;
		const verdict = this.classifier.classify(command)
			.find((value) => TeamsRemoteGuard.BLOCKED.has(value));
		if (verdict === undefined) return undefined;
		return { block: true, reason: this.reason(verdict) };
	}

	/** The shell text a tool call would run, or undefined. */
	private commandOf(event: ToolCallEvent): string | undefined {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const shell = event.toolName === "bash"
			|| event.toolName === "powershell";
		// pi-daemon's submit runs the command later, out of this handler's
		// sight; match it by name only, so the two packages stay independent.
		const submitted = event.toolName === "daemon_tasks"
			&& input.action === "submit";
		if (!shell && !submitted) return undefined;
		const command = input.command;
		return typeof command === "string" && command.trim() !== ""
			? command : undefined;
	}

	private reason(verdict: RemoteVerdict): string {
		const refused = verdict === "headless-pi"
			? "headless pi" : "ssh remote work";
		return `[pi-teams] refused ${refused}: work on another host or in ` +
			"another pi agent goes through pi-teams - team_peer add links a " +
			"host, team_spawn host=<peer> starts a teammate there, then " +
			"team_send/team_wait. Move files with scp, sftp, or rsync. " +
			"Not run. (PI_TEAMS_REMOTE_GUARD=off disables.)";
	}
}
