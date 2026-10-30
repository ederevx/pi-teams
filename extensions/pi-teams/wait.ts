/**
 * Active team_wait ownership: the result poll, the once-per-wait stall
 * nudge, the contact hook, and the direct-message wake. All wait timers
 * and watchers live here, so an ended wait can never leak them.
 */

import type { TeamMessage } from "./protocol.ts";
import {
	DEFAULT_STALL_SECONDS,
	DEFAULT_WAIT_SECONDS,
	STEER_NUDGE_TEXT,
	WAIT_POLL_MS,
} from "./protocol.ts";
import type { ResultInbox } from "./inbox.ts";

/** Sends on the waiting agent's behalf. */
type SendFn = (
	to: string, kind: string, text: string,
) => Promise<unknown>;

/** Why one wait ended: a report, the direct message that woke it,
 *  the bound, a queued user message, an abort, or deregistration. */
export type WaitStopReason =
	"result" | "message" | "timeout" | "yield" | "abort" | "closed";

/** One wait's outcome: the reports aligned to the requested ids (null
 *  when an id never reported), the direct message that ended the
 *  wait early, if any, and why the wait ended. */
export interface WaitOutcome {
	results: Array<TeamMessage | null>;
	interruptedBy: TeamMessage | null;
	stoppedBy: WaitStopReason;
}

/** One agent's active team_wait polls and their stall watchdog. */
export class WaitController {
	private readonly inbox: ResultInbox;
	private readonly send: SendFn;
	private readonly isClosed: () => boolean;
	/** Contact from a blocked-on teammate (any traffic counts as
	 *  life); registered per wait, always removed. */
	private activityHook: ((from: string) => void) | null = null;
	/** A direct message that ends the active wait so it cannot sit
	 *  behind the blocked tool; registered per wait, always removed. */
	private messageHook: ((message: TeamMessage) => void) | null = null;

	constructor(
		inbox: ResultInbox,
		send: SendFn,
		isClosed: () => boolean,
	) {
		this.inbox = inbox;
		this.send = send;
		this.isClosed = isClosed;
	}

	/** Feeds one teammate contact into the watchdog clock. */
	onContact(from: string): void {
		if (this.activityHook) this.activityHook(from);
	}

	/** Ends the active wait when a direct message arrives, so the
	 *  message is steered now instead of waiting behind the blocked
	 *  tool. */
	onMessage(message: TeamMessage): void {
		if (this.messageHook) this.messageHook(message);
	}

	/** Nudges each pending teammate past the stall bound (once per
	 *  wait). */
	private nudgeStalled(
		pending: string[],
		stallMs: number,
		lastActivity: number,
		nudged: Set<string>,
	): void {
		if (stallMs <= 0) return;
		if (Date.now() - lastActivity < stallMs) return;
		for (const id of pending) {
			if (nudged.has(id)) continue;
			nudged.add(id);
			void this.send(id, "text", STEER_NUDGE_TEXT)
				// Undeliverable: the bound or GC still ends it.
				.catch(() => {
				});
		}
	}

	/** Waits for teammates' results: returns on the first result, a
	 *  direct message that wakes the wait, the bound, an abort, a
	 *  queued user message, or deregistration; the other ids keep
	 *  running and report later. All timers and watchers release before
	 *  resolve; a null report means the id never reported. */
	async waitForResults(
		agentIds: string[],
		timeoutMs: number,
		signal: AbortSignal | undefined,
		shouldYield: () => boolean,
		onTick?: () => void,
		stallMs = DEFAULT_STALL_SECONDS * 1000,
		startedAt?: number,
	): Promise<WaitOutcome> {
		const results = new Map<string, TeamMessage>();
		const pending: string[] = [];
		for (const id of agentIds) {
			const buffered = this.inbox.take(id);
			if (buffered) results.set(id, buffered);
			else pending.push(id);
		}
		let interruptedBy: TeamMessage | null = null;
		let stoppedBy: WaitStopReason = "result";
		// A buffered report already satisfies the first-result trigger.
		const canWait = results.size === 0 && pending.length > 0
			&& !this.isClosed() && !signal?.aborted && !shouldYield();
		if (!canWait && results.size === 0) {
			stoppedBy = signal?.aborted ? "abort"
				: this.isClosed() ? "closed" : "yield";
		}
		if (canWait) {
			await new Promise<void>((resolve) => {
				const unwatchers: Array<() => void> = [];
				let timer: ReturnType<typeof setTimeout> | undefined;
				let poll: ReturnType<typeof setInterval> | undefined;
				let settled = false;
				// Watchdog clock: starts with the wait, every
				// teammate contact pushes it forward.
				let lastActivity = Date.now();
				const nudged = new Set<string>();
				const watching = new Set(pending);
				// The bound, on a clock a wall-clock step cannot move,
				// shared with the wait view when the caller passed its
				// own start. A timer delay Node cannot represent (over
				// 2^31-1 ms) fires at once, so the timer rearms on the
				// remainder.
				const deadline = (startedAt ?? performance.now())
					+ (timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_SECONDS * 1000);
				const onActivity = (from: string): void => {
					if (watching.has(from)) lastActivity = Date.now();
				};
				const finish = (reason: WaitStopReason): void => {
					if (settled) return;
					settled = true;
					stoppedBy = reason;
					this.activityHook = null;
					this.messageHook = null;
					if (timer) clearTimeout(timer);
					if (poll) clearInterval(poll);
					signal?.removeEventListener("abort", onAbort);
					for (const unwatch of unwatchers) unwatch();
					resolve();
				};
				const onAbort = (): void => finish("abort");
				const onMessage = (message: TeamMessage): void => {
					interruptedBy = message;
					finish("message");
				};
				this.activityHook = onActivity;
				this.messageHook = onMessage;
				for (const id of pending) {
					const unwatch = this.inbox.watch(id, (message) => {
						lastActivity = Date.now();
						if (!message) {
							finish("closed");
							return;
						}
						results.set(id, message);
						// First result ends the wait; the other ids'
						// later reports stay buffered in the inbox.
						finish("result");
					});
					unwatchers.push(unwatch);
				}
				// Resources precede the first stop check: an instant
				// wait still releases them all.
				const armTimeout = (): void => {
					const remaining = deadline - performance.now();
					if (remaining <= 0) {
						finish("timeout");
						return;
					}
					// Node's maximum representable timer delay.
					timer = setTimeout(armTimeout,
						Math.min(remaining, 0x7fffffff));
				};
				armTimeout();
				poll = setInterval(() => {
					// Stop checks precede the tick's work: an overdue
					// poll must not stream past the bound.
					if (performance.now() >= deadline) {
						finish("timeout");
						return;
					}
					if (this.isClosed()) {
						finish("closed");
						return;
					}
					if (signal?.aborted) {
						finish("abort");
						return;
					}
					if (shouldYield()) {
						finish("yield");
						return;
					}
					this.nudgeStalled(
						pending, stallMs, lastActivity, nudged);
					onTick?.();
				}, WAIT_POLL_MS);
				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) finish("abort");
				}
			});
		}
		return {
			results: agentIds.map((id) => results.get(id) ?? null),
			interruptedBy,
			stoppedBy,
		};
	}
}