/**
 * Spawn routing. One service owns the single spawn path: it asks the
 * broker, which owns the spawn contract, for a teammate on this host or
 * on a linked peer host. Only the target host differs, so no separate
 * per-host backend exists.
 */

import type { BrokerOps } from "./broker-ops.ts";
import type { TeammateRef } from "./protocol.ts";

export type { TeammateRef } from "./protocol.ts";

export interface SpawnOptions {
	provider?: string;
	model?: string;
	thinking?: string;
	/** Override the parent id, for a teammate spawned on behalf of a
	 *  remote agent. Defaults to this agent. */
	parent?: string;
}

/** The single spawn path: one broker op, local or peer-hosted. */
export class SpawnService {
	private readonly host: string;
	private readonly broker: BrokerOps;
	private readonly requester: () => string;
	private readonly cwd: () => string;

	constructor(
		host: string,
		broker: BrokerOps,
		requester: () => string,
		cwd: () => string,
	) {
		this.host = host;
		this.broker = broker;
		this.requester = requester;
		this.cwd = cwd;
	}

	async spawn(
		host: string,
		name: string,
		task: string,
		options: SpawnOptions,
	): Promise<TeammateRef> {
		const remote = Boolean(host && host !== this.host);
		return this.broker.spawn(this.requester(), {
			name,
			task,
			// A session's cwd names a directory on *this* host; a peer
			// spawn runs in the peer's own default directory.
			cwd: remote ? undefined : this.cwd(),
			host: remote ? host : undefined,
			provider: options.provider,
			model: options.model,
			thinking: options.thinking,
			parent: options.parent,
		});
	}
}
