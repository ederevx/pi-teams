/**
 * Message presentation: the append-only log entry and the delivery of an
 * inbound team message to the running agent. This module owns how a
 * TeamMessage is surfaced to pi, not the protocol or transport.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamMessage } from "./protocol.ts";

/** Renders the message payload as display text: a string as-is, any
 *  other shape as JSON. */
function payloadText(message: TeamMessage): string {
	return typeof message.payload === "string"
		? message.payload
		: JSON.stringify(message.payload);
}

/** Formats a team message as the report text the agent reads. One
 *  owner for the report wording, shared by message delivery and the
 *  team_wait tool result. */
export function formatReport(message: TeamMessage): string {
	return `pi-teams ${message.kind} from ${message.from}:\n` +
		payloadText(message);
}

/** Records a one-line, truncated log entry for a team message. The
 *  renderer shows the preview, or the full payload when expanded. */
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

/** Surfaces an inbound team message to the agent as a custom message.
 *  Registered as the TeamAgent's deliver callback. */
export function deliverToAgent(pi: ExtensionAPI, message: TeamMessage): void {
	logTeamMessage(pi, "received", message);
	// A notice is bookkeeping (for example a teammate announcing its
	// session); record it without forcing a model turn.
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