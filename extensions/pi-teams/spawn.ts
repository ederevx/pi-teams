/**
 * Spawn routing. SpawnBackend is the one spawn interface; only the
 * backend differs by host, and SpawnRouter selects it. A local spawn
 * launches the process here; a peer spawn asks the peer host's main
 * agent to spawn.
 */

import type { AgentDirectory } from "./directory.ts";

export interface SpawnOptions {
	provider?: string;
	model?: string;
	thinking?: string;
	/** Override the parent id, for a teammate spawned on behalf of a
	 *  remote agent. Defaults to this agent. */
	parent?: string;
	/** "fresh" (default) starts a clean context and never carries the
	 *  parent's history; "inherit" forks the parent session so the
	 *  teammate can reuse its warm prompt-cache prefix. */
	context?: "fresh" | "inherit";
}

export interface TeammateRef {
	id: string;
	session: string;
}

/** One spawn interface; only the backend differs by host. */
export interface SpawnBackend {
	spawn(
		name: string,
		task: string,
		options: SpawnOptions,
	): Promise<TeammateRef | null>;
}

/** Spawns the teammate's process on this host. */
export class LocalSpawnBackend implements SpawnBackend {
	private readonly launch: (
		name: string,
		task: string,
		options: SpawnOptions,
	) => TeammateRef;

	constructor(
		launch: (
			name: string,
			task: string,
			options: SpawnOptions,
		) => TeammateRef,
	) {
		this.launch = launch;
	}

	async spawn(
		name: string,
		task: string,
		options: SpawnOptions,
	): Promise<TeammateRef | null> {
		return this.launch(name, task, options);
	}
}

/** Asks a linked peer host's main agent to spawn the teammate. The peer
 *  owns the process and session; this agent only requested the work. */
export class PeerSpawnBackend implements SpawnBackend {
	private readonly host: string;
	private readonly directory: AgentDirectory;
	private readonly send: (
		to: string,
		kind: string,
		text: string,
	) => Promise<string>;
	private readonly wait: (
		requestId: string,
		timeoutMs: number,
	) => Promise<TeammateRef | null>;

	constructor(
		host: string,
		directory: AgentDirectory,
		send: (to: string, kind: string, text: string) => Promise<string>,
		wait: (requestId: string, timeoutMs: number) =>
			Promise<TeammateRef | null>,
	) {
		this.host = host;
		this.directory = directory;
		this.send = send;
		this.wait = wait;
	}

	async spawn(
		name: string,
		task: string,
		options: SpawnOptions,
	): Promise<TeammateRef | null> {
		const target = await this.directory.mainAgent(this.host);
		if (!target) return null;
		const requestId =
			`spawn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
		const pending = this.wait(requestId, 15000);
		await this.send(target.id, "spawn", JSON.stringify({
			task, name, requestId,
		}));
		return pending;
	}
}

/** A host address is routed through one interface: a host-less or
 *  this-host spawn uses the local backend, any other host is a linked
 *  peer whose request travels over the broker's peer link. */
export class SpawnRouter {
	private readonly host: string;
	private readonly local: SpawnBackend;
	private readonly makePeer: (host: string) => SpawnBackend;
	private readonly peers = new Map<string, SpawnBackend>();

	constructor(
		host: string,
		local: SpawnBackend,
		makePeer: (host: string) => SpawnBackend,
	) {
		this.host = host;
		this.local = local;
		this.makePeer = makePeer;
	}

	backendFor(host: string): SpawnBackend {
		if (!host || host === this.host) return this.local;
		let backend = this.peers.get(host);
		if (!backend) {
			backend = this.makePeer(host);
			this.peers.set(host, backend);
		}
		return backend;
	}

	spawn(
		host: string,
		name: string,
		task: string,
		options: SpawnOptions,
	): Promise<TeammateRef | null> {
		return this.backendFor(host).spawn(name, task, options);
	}

	/** Releases the cached per-host backends; GC on deregister. */
	clear(): void {
		this.peers.clear();
	}
}