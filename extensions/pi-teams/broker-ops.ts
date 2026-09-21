/**
 * The single broker-op client. Every request/response call to the
 * python client (team.py) goes through here, so no other module owns
 * broker argv and no module branches on local vs peer transport: the
 * broker routes a request to whichever host owns the target.
 */

import type { AgentInfo } from "./directory.ts";
import { stateRoot, teamBin } from "./paths.ts";
import type { ProcessHost } from "./process-runner.ts";

/** A linked peer host as reported by the broker's peer list. */
export interface PeerInfo {
	label: string;
	host: string;
	online: boolean;
	ssh: string;
}

interface BrokerReply {
	op?: string;
	label?: string;
	host?: string;
	detail?: string;
	setup?: string;
	error?: string;
	agents?: AgentInfo[];
	peers?: PeerInfo[];
}

/** Owns the broker-op argv and reply parsing. */
export class BrokerOps {
	private readonly runner: ProcessHost;
	private readonly python: string;

	constructor(runner: ProcessHost, python: string) {
		this.runner = runner;
		this.python = python;
	}

	private run(args: string[], timeout = 3000) {
		return this.runner.run(
			this.python, [teamBin, "--root", stateRoot, ...args],
			{ timeout },
		);
	}

	private parse(stdout: unknown): BrokerReply {
		try {
			return JSON.parse(String(stdout)) as BrokerReply;
		} catch {
			return {};
		}
	}

	async snapshot(): Promise<AgentInfo[]> {
		return this.parse((await this.run(["ls"])).stdout).agents ?? [];
	}

	async peers(): Promise<PeerInfo[]> {
		return this.parse(
			(await this.run(["peer", "list"])).stdout).peers ?? [];
	}

	async send(
		to: string,
		kind: string,
		text: string,
		id: string,
	): Promise<string> {
		const result = await this.run(
			["send", "--id", id, to, kind, text]);
		return String(result.stdout).trim();
	}

	async terminate(agentId: string): Promise<void> {
		await this.run(["terminate", agentId]);
	}

	/** Links a peer host. The broker owns the ssh tunnel; a failure
	 *  carries the one-line setup a password-only host needs. */
	async peerAdd(label: string, ssh: string): Promise<PeerInfo> {
		const result = await this.run(
			["peer", "add", "--label", label, "--ssh", ssh], 40000);
		const reply = this.parse(result.stdout);
		if (reply.op === "error") {
			throw new Error(this.unreachable(ssh, reply));
		}
		return {
			label: reply.label || label,
			host: reply.host || label,
			online: true,
			ssh,
		};
	}

	async peerRemove(label: string): Promise<void> {
		await this.run(["peer", "remove", label], 10000);
	}

	private unreachable(ssh: string, reply: BrokerReply): string {
		const reason = reply.detail
			|| "ssh is not usable non-interactively";
		if (reply.setup) {
			return `SSH to ${ssh} is not usable non-interactively ` +
				`(${reason}). Do not ask for a password; ask the user to ` +
				`run this one line in their terminal, then retry ` +
				`team_peer:\n  ${reply.setup}`;
		}
		return `peer ${ssh} unreachable: ${reason}`;
	}
}