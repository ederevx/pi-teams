/**
 * Shared message envelope, wait defaults, and the deliver callback type.
 * The wire protocol shape is the only responsibility this module owns.
 */

export interface TeamMessage {
	from: string;
	to: string;
	kind: string;
	payload: unknown;
	ts?: number;
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

/** Mints a send token: the session's credential for gated broker ops.
 *  One owner for both the session token and a spawned teammate's
 *  fresh one, so token generation stays in the protocol module. */
export function mintSendToken(): string {
	return `stk-${Date.now().toString(16)}-` +
		Math.random().toString(16).slice(2, 10) +
		Math.random().toString(16).slice(2, 10);
}

/** Default bound for an active team_wait, overridable with PI_TEAMS_WAIT. */
export const DEFAULT_WAIT_SECONDS = 300;

/** How often an active team_wait re-checks its stop conditions. */
export const WAIT_POLL_MS = 250;

/** One spawn request's answer window per candidate target, in ms;
 *  overridable with PI_TEAMS_SPAWN_WINDOW. A target that stays silent
 *  past it fails, and the next candidate on the host is tried. */
export const DEFAULT_SPAWN_WINDOW_MS = 15000;

/** Resolves the spawn answer window from the environment, then the
 *  default. */
export function spawnWindowMs(): number {
	const env = Number(process.env.PI_TEAMS_SPAWN_WINDOW);
	return Number.isFinite(env) && env > 0 ? env : DEFAULT_SPAWN_WINDOW_MS;
}

/** Default silence bound before team_wait nudges silent teammates,
 *  overridable with PI_TEAMS_STALL; 0 disables the nudge. */
export const DEFAULT_STALL_SECONDS = 90;

/** The steering message a wait sends a teammate that has gone silent.
 *  One owner for the nudge wording, shared by the wait tool's stall
 *  watchdog wherever it fires. */
export const STEER_NUDGE_TEXT =
	"team_wait: you have not reported for a while and may look hung. " +
	"If you are still working, continue; if you are done or stuck, " +
	"report your result to your parent now.";

/** Resolves the team_wait bound from the call, then the environment. */
export function waitSeconds(requested?: number): number {
	if (typeof requested === "number" && requested > 0) return requested;
	const env = Number(process.env.PI_TEAMS_WAIT);
	return Number.isFinite(env) && env > 0 ? env : DEFAULT_WAIT_SECONDS;
}

/** Resolves the stall bound from the call (0 disables), then the
 *  environment, then the default. An explicit 0 wins over every other
 *  source so a call can turn the watchdog off. */
export function stallSeconds(requested?: number): number {
	if (typeof requested === "number" && requested >= 0) return requested;
	const env = Number(process.env.PI_TEAMS_STALL);
	if (Number.isFinite(env) && env >= 0) return env;
	return DEFAULT_STALL_SECONDS;
}