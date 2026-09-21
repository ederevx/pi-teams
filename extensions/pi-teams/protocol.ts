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

/** Default bound for an active team_wait, overridable with PI_TEAMS_WAIT. */
export const DEFAULT_WAIT_SECONDS = 300;

/** How often an active team_wait re-checks its stop conditions. */
export const WAIT_POLL_MS = 250;

/** Resolves the team_wait bound from the call, then the environment. */
export function waitSeconds(requested?: number): number {
	if (typeof requested === "number" && requested > 0) return requested;
	const env = Number(process.env.PI_TEAMS_WAIT);
	return Number.isFinite(env) && env > 0 ? env : DEFAULT_WAIT_SECONDS;
}