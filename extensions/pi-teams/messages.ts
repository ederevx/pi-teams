/**
 * Message presentation: log entries, inbound delivery, the pre-turn
 * awareness note, and the log renderer. Owns how team traffic is
 * surfaced to pi, not the protocol or transport.
 */

import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentInfo } from "./directory.ts";
import { stateRoot } from "./paths.ts";
import type { TeamMessage } from "./protocol.ts";

/** Renders the message payload as display text: a string as-is, any
 *  other shape as JSON. */
function payloadText(message: TeamMessage): string {
	return typeof message.payload === "string"
		? message.payload
		: JSON.stringify(message.payload);
}

/** The report text the agent reads (delivery and team_wait result). */
export function formatReport(message: TeamMessage): string {
	return `pi-teams ${message.kind} from ${message.from}:\n` +
		payloadText(message);
}

/** Records a truncated one-line log entry (renderer shows the
 *  preview, or the full payload when expanded). */
export function logTeamMessage(
	pi: ExtensionAPI,
	direction: "sent" | "received",
	message: TeamMessage,
): void {
	const payload = payloadText(message);
	const preview = payload.length > 96
		? `${payload.slice(0, 93)}...`
		: payload;
	pi.appendEntry("pi-teams-log", {
		direction,
		from: message.from,
		to: message.to,
		kind: message.kind,
		preview,
		payload,
	});
}

/** Surfaces an inbound team message (the TeamAgent deliver callback). */
export function deliverToAgent(pi: ExtensionAPI, message: TeamMessage): void {
	logTeamMessage(pi, "received", message);
	// A notice (e.g. a session announcement) is bookkeeping only.
	if (message.kind === "notice") return;
	void pi.sendMessage(
		{
			customType: "pi-teams",
			content: formatReport(message),
			display: true,
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

/** Registers the renderer for the team-message log entries. */
export function registerLogRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer("pi-teams-log", (entry, options, theme) => {
		const data = entry.data as {
			direction?: string;
			from?: string;
			kind?: string;
			preview?: string;
			payload?: string;
		} | undefined;
		const arrow = data?.direction === "sent" ? "->" : "<-";
		const head = `[pi-teams] ${arrow} ${data?.from ?? "?"} ` +
			`(${data?.kind ?? "text"})`;
		const lines = options.expanded && data?.payload
			? [theme.fg("dim", head)]
				.concat(data.payload.split("\n").map((line) =>
					theme.fg("dim", `  ${line}`)))
			: [theme.fg("dim", `${head}: ${data?.preview ?? ""}`)];
		return { render: () => lines, invalidate() {} };
	});
}

/** The pre-turn awareness note: live team plus the calls to reach or
 *  spawn teammates, labeled with its broker root. */
export function announceAgents(
	agents: AgentInfo[],
): { customType: string; content: string; display: boolean } | null {
	const lines = agents
		.slice(0, 8)
		.map((a) =>
			`- ${a.id} ${a.name} (${a.role}, ${a.online ? "online" : "offline"}` +
			(a.session ? `, session ${basename(a.session)}` : "") +
			`)`);
	const content =
		`## pi-teams teammates (broker: ${stateRoot})\n` +
		`${lines.join("\n") || "- none live yet"}\n` +
		`Reach or spawn teammates by tool call (team_send, team_wait, ` +
		`team_attach, team_detach, team_kill, team_spawn; team_peer ` +
		`links a peer host; /team-ls opens the dock). Teammates ` +
		`message only their own team.`;
	return { customType: "pi-teams", content, display: false };
}