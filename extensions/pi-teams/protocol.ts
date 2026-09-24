/**
 * Shared message envelope, wait defaults, and the deliver callback type.
 * The wire protocol shape is the only responsibility this module owns.
 */

import {
	settings,
	DEFAULT_SPAWN_WINDOW_MS,
	DEFAULT_STALL_SECONDS,
	DEFAULT_WAIT_SECONDS,
} from "./settings.ts";

export { DEFAULT_SPAWN_WINDOW_MS, DEFAULT_STALL_SECONDS,
	DEFAULT_WAIT_SECONDS };

export interface TeamMessage {
	from: string;
	to: string;
	kind: string;
	payload: unknown;
	ts?: number;
	/** Wire id the broker stamps on delivered envelopes; a client
	 *  filters redeliveries (mailbox handoff after a crash) by it. */
	id?: string;
}

export type DeliverFn = (message: TeamMessage) => void;

/** A spawned or attached teammate's id and session name. */
export interface TeammateRef {
	id: string;
	session: string;
}

/** Mints a collision-resistant id for a request/response exchange. */
export function requestId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

/** Mints a send token: the session credential for gated broker ops
 *  (session and spawned teammates alike). */
export function mintSendToken(): string {
	return `stk-${Date.now().toString(16)}-` +
		Math.random().toString(16).slice(2, 10) +
		Math.random().toString(16).slice(2, 10);
}

/** How often an active team_wait re-checks its stop conditions. */
export const WAIT_POLL_MS = 250;

/** The spawn answer window per candidate target, in ms (settings or
 *  PI_TEAMS_SPAWN_WINDOW override). A silent target fails to the next
 *  candidate on the host. */
export function spawnWindowMs(): number {
	return settings.spawnWindowMs();
}

/** The steering message a wait sends a teammate gone silent. */
export const STEER_NUDGE_TEXT =
	"team_wait: you have not reported for a while and may look hung. " +
	"If you are still working, continue; if you are done or stuck, " +
	"report your result to your parent now.";

/** Resolves the team_wait bound from the call, then settings (env or
 *  file), then the default. */
export function waitSeconds(requested?: number): number {
	if (typeof requested === "number" && requested > 0) return requested;
	return settings.waitSeconds();
}

/** Resolves the stall bound from the call (0 disables), then settings
 *  (env or file), then the default. An explicit 0 wins over every other
 *  source so a call can turn the watchdog off. */
export function stallSeconds(requested?: number): number {
	if (typeof requested === "number" && requested >= 0) return requested;
	return settings.stallSeconds();
}