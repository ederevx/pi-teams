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
	/** Broker pass-through liveness fields (epoch seconds). `last_work`
	 *  is the last busy/work contact; `last_seen` any traffic. */
	"last_work"?: number;
	"last_seen"?: number;
}

/** Resolves a host label to its live agents. Brokers prefix ids with
 *  the host label, so a peer's agents are addressed like local ones;
 *  only the backend that reaches them differs. */
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
		return (await this.mainAgents(host))[0] ?? null;
	}

	/** Every live candidate on `host` that may serve a host-addressed
	 *  request, mains first. Callers try them in order: an agent can
	 *  hold its broker connection while its pi process no longer
	 *  surfaces messages, so a single pick would strand requests. */
	async mainAgents(host: string): Promise<AgentInfo[]> {
		const agents = await this.snapshot();
		const own = (a: AgentInfo): boolean =>
			a.origin === host || a.id.startsWith(`${host}:`);
		const mains = agents.filter((a) => own(a) && a.role === "main");
		return mains.length > 0 ? mains : agents.filter(own);
	}
}