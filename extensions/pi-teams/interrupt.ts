/**
 * Urgent-run preemption: a control message that must stop the current
 * run (so a tool blocked on it returns) and then surface as a fresh
 * turn once the run settles. Ordinary traffic never enters here; the
 * gate holds only what the session must not miss.
 */

import type { DeliverFn, TeamMessage } from "./protocol.ts";

/** Holds urgent messages across a run abort and releases them at the
 *  next settle; an idle session has nothing to preempt. */
export class InterruptGate {
	private readonly deliver: DeliverFn;
	private abort: (() => void) | null = null;
	private isIdle: (() => boolean) | null = null;
	private held: TeamMessage[] = [];

	constructor(deliver: DeliverFn) {
		this.deliver = deliver;
	}

	/** Binds the session's abort and idle probes from an
	 *  ExtensionContext; the runner binds both once per session. */
	bind(abort: () => void, isIdle: () => boolean): void {
		this.abort = abort;
		this.isIdle = isIdle;
	}

	/** Preempts the current run for `message`: a running session is
	 *  aborted (freeing a blocked tool) and the message waits for the
	 *  settle to open its turn; an idle session delivers it now. */
	request(message: TeamMessage): void {
		if (this.abort && this.isIdle && !this.isIdle()) {
			this.held.push(message);
			this.abort();
			return;
		}
		this.deliver(message);
	}

	/** Delivers everything held while a run was being preempted. */
	settle(): void {
		const held = this.held;
		this.held = [];
		for (const message of held) this.deliver(message);
	}
}
