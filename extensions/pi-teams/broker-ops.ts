/**
 * The single broker-op client: every request/response call to team.py
 * goes through here, so no other module owns broker argv or branches
 * on local vs peer transport (the broker routes to the target's host).
 */

import type { AgentInfo } from "./directory.ts";
import type { TeammateRef } from "./protocol.ts";
import { stateRoot, teamBin } from "./paths.ts";
import type { ProcessHost } from "./process-runner.ts";

/** A linked peer host as reported by the broker's peer list. */
export interface PeerInfo {
	label: string;
	host: string;
	online: boolean;
	ssh: string;
}

/** The broker-owned spawn contract's request fields. The broker owns
 *  the session, so the client names only the work and the target. */
export interface SpawnFields {
	name: string;
	task: string;
	cwd?: string;
	host?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	parent?: string;
}

interface BrokerReply {
	op?: string;
	label?: string;
	host?: string;
	detail?: string;
	setup?: string;
	error?: string;
	ok?: boolean;
	id?: string;
	session?: string;
	agents?: AgentInfo[];
	peers?: PeerInfo[];
}

/** Owns the broker-op argv and reply parsing. */
export class BrokerOps {
	private readonly runner: ProcessHost;
	private readonly python: string;
	/** The composing agent's send credential; a gated op (send) must
	 *  present it, so identity args alone cannot speak for an agent. */
	sendToken = "";

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
		sendToken?: string,
	): Promise<string> {
		const args = ["send", "--id", id];
		if (sendToken) {
			args.push("--send-token", sendToken);
		}
		const result = await this.run(
			[...args, to, kind, text]);
		return String(result.stdout).trim();
	}

	/** The broker-owned spawn: one op for local and peer hosts, routed
	 *  by the broker's own link. Resolves the new teammate's id and
	 *  session, or throws the broker's error. */
	async spawn(
		id: string,
		fields: SpawnFields,
		timeout = 20000,
	): Promise<TeammateRef> {
		const args = [
			"spawn", "--id", id, "--task", fields.task,
			"--name", fields.name,
		];
		if (this.sendToken) args.push("--send-token", this.sendToken);
		if (fields.cwd) args.push("--cwd", fields.cwd);
		if (fields.host) args.push("--host", fields.host);
		if (fields.provider) args.push("--provider", fields.provider);
		if (fields.model) args.push("--model", fields.model);
		if (fields.thinking) args.push("--thinking", fields.thinking);
		if (fields.parent) args.push("--parent", fields.parent);
		const reply = this.parse((await this.run(args, timeout)).stdout);
		if (reply.error) {
			const detail = reply.detail ? `: ${reply.detail}` : "";
			throw new Error(`${reply.error}${detail}`);
		}
		if (!reply.id) throw new Error("spawn failed: no id returned");
		return { id: reply.id, session: reply.session || reply.id };
	}

	async terminate(agentId: string): Promise<void> {
		await this.run(["terminate", agentId], 25000);
	}

	/** The voluntary reap: answers the broker's idle request with this
	 *  agent's identity and credential, so the broker drops the
	 *  registration and its files. The caller owns ctx.shutdown(). */
	async gcReap(agentId: string, sendToken?: string): Promise<void> {
		const args = ["reap", "--id", agentId];
		if (sendToken) args.push("--send-token", sendToken);
		await this.run(args);
	}

	/** Links a peer host; the broker owns the ssh tunnel, and a
	 *  failure carries the one-line setup a password-only host needs. */
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