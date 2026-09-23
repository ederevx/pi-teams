/**
 * Request/response ownership for spawn and attach: one registry per
 * request id (waiter + timeout), so a cancelled or timed-out request
 * never leaks a timer and no two replies double-resolve a waiter.
 */

import type { TeamMessage, TeammateRef } from "./protocol.ts";

/** All in-flight waiter state and timers live here. */
export class PendingRequests {
	private readonly waiters =
		new Map<string, (ref: TeammateRef | null) => void>();
	private readonly timers =
		new Map<string, ReturnType<typeof setTimeout>>();
	private cancelled = false;

	/** Registers one request; resolves to null on timeout or cancellation. */
	register(
		requestId: string,
		timeoutMs: number,
	): Promise<TeammateRef | null> {
		if (this.cancelled || this.waiters.has(requestId)) {
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			this.waiters.set(requestId, resolve);
			this.timers.set(requestId, setTimeout(
				() => this.finish(requestId, null), timeoutMs));
		});
	}

	/** Resolves the request named by a reply; `ackKind` marks success,
	 *  any other kind (or a missing id) resolves it as failed. */
	settle(message: TeamMessage, ackKind: string): void {
		const payload = (message.payload ?? {}) as {
			requestId?: string;
			id?: string;
			session?: string;
		};
		if (!payload.requestId) return;
		if (message.kind === ackKind && payload.id) {
			this.finish(payload.requestId, {
				id: payload.id, session: payload.session || payload.id,
			});
			return;
		}
		this.finish(payload.requestId, null);
	}

	/** Resolves every waiter as cancelled; a later register resolves at
	 *  once. GC on deregister so no timer outlives the session. */
	cancelAll(): void {
		this.cancelled = true;
		for (const requestId of [...this.waiters.keys()]) {
			this.finish(requestId, null);
		}
	}

	private finish(requestId: string, ref: TeammateRef | null): void {
		const timer = this.timers.get(requestId);
		if (timer) clearTimeout(timer);
		this.timers.delete(requestId);
		const resolve = this.waiters.get(requestId);
		this.waiters.delete(requestId);
		resolve?.(ref);
	}
}