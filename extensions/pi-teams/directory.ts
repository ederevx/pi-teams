/**
 * Host-label routing over the broker's agent registry. A directory
 * resolves a host to its live agents; it does not talk to a broker
 * directly, only through an injected snapshot function.
 */

export interface AgentInfo {
	id: string;
	name: string;
	role: string;
	pid: number;
	parent: string | null;
	session: string | null;
	online: boolean;
	origin?: string;
	remote?: boolean;
}

/** Resolves a host label to its live agents. Every broker prefixes its
 *  agents' ids with the host label, so a peer's agents are addressed
 *  exactly like local ones; only the backend that reaches them differs. */
export class AgentDirectory {
	private readonly snapshot: () => Promise<AgentInfo[]>;
	private readonly host: string;

	constructor(snapshot: () => Promise<AgentInfo[]>, host: string) {
		this.snapshot = snapshot;
		this.host = host;
	}

	/** A host-less target or this host is local. */
	isLocal(host: string): boolean {
		return !host || host === this.host;
	}

	/** The live main agent that owns `host`, or a fallback agent there.
	 *  This is the target a host-addressed request is delivered to. */
	async mainAgent(host: string): Promise<AgentInfo | null> {
		const agents = await this.snapshot();
		const own = (a: AgentInfo): boolean =>
			a.origin === host || a.id.startsWith(`${host}:`);
		return agents.find((a) => own(a) && a.role === "main")
			?? agents.find(own) ?? null;
	}
}