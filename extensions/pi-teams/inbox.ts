/**
 * Result ownership for active team_wait polls: the waiters registered
 * for a sender and the results that arrived just before a wait began.
 * This module owns all waiter state, so a cancelled or timed-out wait
 * can never leak or double-consume.
 */

import type { TeamMessage } from "./protocol.ts";

/** Owns the active team_wait waiters and results that arrived just
 *  before a wait began. A result is consumed exactly once: by a
 *  registered waiter, or buffered for the next wait. */
export class ResultInbox {
	private readonly waiters =
		new Map<string, Set<(message: TeamMessage | null) => void>>();
	private readonly buffered = new Map<string, TeamMessage>();

	/** Hands a result to its sender's waiters, or buffers it. Returns
	 *  true when a waiter consumed it. */
	deliver(message: TeamMessage): boolean {
		const waiting = this.waiters.get(message.from);
		if (!waiting || waiting.size === 0) {
			this.buffered.set(message.from, message);
			return false;
		}
		this.waiters.delete(message.from);
		for (const settle of waiting) settle(message);
		return true;
	}

	/** Takes a result that arrived before this wait started. */
	take(agentId: string): TeamMessage | undefined {
		const message = this.buffered.get(agentId);
		if (message) this.buffered.delete(agentId);
		return message;
	}

	/** Registers one waiter; the returned function removes it without
	 *  consuming a result. */
	watch(
		agentId: string,
		settle: (message: TeamMessage | null) => void,
	): () => void {
		const set = this.waiters.get(agentId) ?? new Set();
		set.add(settle);
		this.waiters.set(agentId, set);
		return () => {
			const current = this.waiters.get(agentId);
			if (!current) return;
			current.delete(settle);
			if (current.size === 0) this.waiters.delete(agentId);
		};
	}

	/** Releases every waiter (as cancelled) and drops buffered results;
	 *  GC on deregister so no timer or waiter outlives the session. */
	cancelAll(): void {
		for (const set of [...this.waiters.values()]) {
			for (const settle of [...set]) settle(null);
		}
		this.waiters.clear();
		this.buffered.clear();
	}
}