/**
 * Spawn routing. One service owns the single spawn path: a host-less or
 * this-host spawn launches the teammate's process here, any other host
 * asks that host's main agent through the broker. Only the address
 * differs, so no separate per-host backend exists.
 */

import type { AgentDirectory } from "./directory.ts";
import type { BrokerOps } from "./broker-ops.ts";
import {
	requestId,
	spawnWindowMs,
	type TeammateRef,
} from "./protocol.ts";
import type { PendingRequests } from "./pending.ts";

export type { TeammateRef } from "./protocol.ts";

export interface SpawnOptions {
	provider?: string;
	model?: string;
	thinking?: string;
	/** Override the parent id, for a teammate spawned on behalf of a
	 *  remote agent. Defaults to this agent. */
	parent?: string;
}

/** The single spawn path: local launch here, or a request to a peer
 *  host's main agent over the broker's existing link. */
export class SpawnService {
	private readonly host: string;
	private readonly directory: AgentDirectory;
	private readonly broker: BrokerOps;
	private readonly pending: PendingRequests;
	private readonly launch: (
		name: string,
		task: string,
		options: SpawnOptions,
	) => TeammateRef;

	constructor(
		host: string,
		directory: AgentDirectory,
		broker: BrokerOps,
		pending: PendingRequests,
		launch: (
			name: string,
			task: string,
			options: SpawnOptions,
		) => TeammateRef,
	) {
		this.host = host;
		this.directory = directory;
		this.broker = broker;
		this.pending = pending;
		this.launch = launch;
	}

	async spawn(
		host: string,
		name: string,
		task: string,
		options: SpawnOptions,
	): Promise<TeammateRef | null> {
		if (!host || host === this.host) {
			return this.launch(name, task, options);
		}
		return this.remote(host, name, task, options);
	}

	private async remote(
		host: string,
		name: string,
		task: string,
		options: SpawnOptions,
	): Promise<TeammateRef | null> {
		const candidates = await this.directory.mainAgents(host);
		if (candidates.length === 0) return null;
		// One request window per candidate: a timeout or a spawn-error
		// only fails that target, so the next live main is tried instead
		// of stranding the spawn behind one unresponsive session.
		for (const target of candidates) {
			const id = requestId("spawn");
			const wait = this.pending.register(id, spawnWindowMs());
			try {
				await this.broker.send(target.id, "spawn", JSON.stringify({
					task,
					name,
					requestId: id,
					provider: options.provider,
					model: options.model,
					thinking: options.thinking,
				}));
			} catch {
				continue;
			}
			const ref = await wait;
			if (ref) return ref;
		}
		return null;
	}
}