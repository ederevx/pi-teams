/**
 * Active team_wait ownership: the result poll, the once-per-wait stall
 * nudge, and the contact hook. All wait timers and watchers live here,
 * so an ended wait can never leak them.
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

/** One agent's active team_wait polls and their stall watchdog. */
export class WaitController {
	private readonly inbox: ResultInbox;
	private readonly send: SendFn;
	private readonly isClosed: () => boolean;
	/** Contact from a blocked-on teammate (any traffic counts as
	 *  life); registered per wait, always removed. */
	private activityHook: ((from: string) => void) | null = null;

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

	/** Waits for teammates' results: returns on the first result, the
	 *  bound, an abort, a queued user message, or deregistration; the
	 *  other ids keep running and report later. All timers and
	 *  watchers release before resolve; null when unreported. */
	async waitForResults(
		agentIds: string[],
		timeoutMs: number,
		signal: AbortSignal | undefined,
		shouldYield: () => boolean,
		onTick?: () => void,
		stallMs = DEFAULT_STALL_SECONDS * 1000,
	): Promise<Array<TeamMessage | null>> {
		const results = new Map<string, TeamMessage>();
		const pending: string[] = [];
		for (const id of agentIds) {
			const buffered = this.inbox.take(id);
			if (buffered) results.set(id, buffered);
			else pending.push(id);
		}
		// A buffered report already satisfies the first-result trigger.
		const canWait = results.size === 0 && pending.length > 0
			&& !this.isClosed() && !signal?.aborted && !shouldYield();
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
				const onActivity = (from: string): void => {
					if (watching.has(from)) lastActivity = Date.now();
				};
				this.activityHook = onActivity;
				const finish = (): void => {
					if (settled) return;
					settled = true;
					this.activityHook = null;
					if (timer) clearTimeout(timer);
					if (poll) clearInterval(poll);
					signal?.removeEventListener("abort", onAbort);
					for (const unwatch of unwatchers) unwatch();
					resolve();
				};
				const onAbort = (): void => finish();
				for (const id of pending) {
					const unwatch = this.inbox.watch(id, (message) => {
						lastActivity = Date.now();
						if (!message) {
							finish();
							return;
						}
						results.set(id, message);
						// First result ends the wait; the other ids'
						// later reports stay buffered in the inbox.
						finish();
					});
					unwatchers.push(unwatch);
				}
				// Resources precede the first stop check: an instant
				// wait still releases them all.
				const effective = timeoutMs > 0
					? timeoutMs : DEFAULT_WAIT_SECONDS * 1000;
				timer = setTimeout(finish, effective);
				poll = setInterval(() => {
					this.nudgeStalled(
						pending, stallMs, lastActivity, nudged);
					onTick?.();
					if (this.isClosed() || signal?.aborted || shouldYield()) {
						finish();
					}
				}, WAIT_POLL_MS);
				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) finish();
				}
			});
		}
		return agentIds.map((id) => results.get(id) ?? null);
	}
}