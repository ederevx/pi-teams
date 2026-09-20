/**
 * pi-teams - cross-pi-agent communication and self-forks.
 *
 * On session start this extension registers the running pi process with
 * the team broker (src/teamd.py) through a held connection, so the agent
 * gains an endpoint other agents can reach. A compact awareness note is
 * injected before the agent first runs, listing live teammates and the
 * commands used to reach or spawn them. A spawned fork runs a pi process
 * whose environment names this agent as its parent; the broker
 * terminates the fork when the parent process dies, so teammates cannot
 * outlive the agent that spawned them.
 *
 * The held connection and the forked pi are launched with Node's
 * child_process, not pi.exec: pi.exec opens the child's stdin to
 * /dev/null and drops the env option, which would make the hold see EOF
 * immediately and strip a fork of its identity. A stdin pipe owned by
 * this process keeps the hold alive exactly as long as the pi runs.
 *
 * The broker and client live in the pi-teams repository and are expected
 * at $HOME/.local/bin (or PI_TEAMS_BIN). Override the pi binary for
 * forks with PI_TEAMS_PI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const home = process.env.HOME || ".";
const stateRoot =
	process.env.TEAM_ROOT ||
	`${process.env.XDG_STATE_HOME || `${home}/.local/state`}/pi-teams`;
const binDir = process.env.PI_TEAMS_BIN || `${home}/.local/bin`;
const python = process.env.PYTHON || "python3";
const teamdBin = `${binDir}/teamd`;
const teamBin = `${binDir}/team`;

/**
 * How to launch another pi without a shell. Reusing the running runtime
 * avoids spawning a Windows launcher shim (pi.cmd/pi.ps1) directly,
 * which child_process cannot execute; pi's own subagent helper resolves
 * it the same way. PI_TEAMS_PI overrides the command for forks.
 */
function piInvocation(): { command: string; args: string[] } {
	const override = process.env.PI_TEAMS_PI;
	if (override) return { command: override, args: [] };
	const entry = process.argv[1];
	if (entry && existsSync(entry) && !entry.startsWith("/$bunfs/root/")) {
		return { command: process.execPath, args: [entry] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args: [] };
	}
	return { command: "pi", args: [] };
}

interface AgentInfo {
	id: string;
	name: string;
	role: string;
	pid: number;
	parent: string | null;
	online: boolean;
}

interface SpawnedProcess {
	stdin: { end(): void } | null;
	on(event: string, listener: () => void): void;
	unref(): void;
	kill(): void;
}

type ExecFn = (file: string, args: string[], options?: object) => Promise<unknown>;
type SpawnFn = (
	file: string,
	args: string[],
	options?: Record<string, unknown>,
) => SpawnedProcess;

export interface SpawnRequest {
	name: string;
	argv: string[];
}

export class TeamAgent {
	readonly exec: ExecFn;
	private readonly spawnProcess: SpawnFn;
	id: string = "";
	private announced = false;
	private holdProc: SpawnedProcess | null = null;

	constructor(exec: ExecFn, spawnProcess: SpawnFn = nodeSpawn) {
		this.exec = exec;
		this.spawnProcess = spawnProcess;
		this.id =
			process.env.TEAM_ID ||
			`pi-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
	}

	private launch(
		file: string,
		args: string[],
		options: Record<string, unknown>,
	): SpawnedProcess | null {
		try {
			const child = this.spawnProcess(file, args, options);
			child.on("error", () => {
				// A failed broker/hold/pi start must not crash the
				// session; the next /team call retries.
			});
			return child;
		} catch {
			return null;
		}
	}

	ensureBroker(): void {
		if (existsSync(`${stateRoot}/endpoint`)) return;
		// The broker never exits; detach it so it outlives the session
		// that happened to start it.
		const child = this.launch(
			python,
			[teamdBin, "--root", stateRoot, "start"],
			{ detached: true, stdio: "ignore", windowsHide: true },
		);
		child?.unref();
	}

	hold(cwd?: string): void {
		this.stopHold();
		const name = process.env.TEAM_NAME || `pi@${cwd || process.cwd()}`;
		const role = process.env.TEAM_ID ? "fork" : "main";
		const parent = process.env.TEAM_PARENT_ID || "";
		const session = process.env.PI_SESSION_FILE || "";
		const busyFile = `${stateRoot}/${this.id}.busy`;
		const env = {
			...process.env,
			TEAM_ID: this.id,
			TEAM_NAME: name,
			TEAM_ROLE: role,
			TEAM_PARENT_ID: parent,
			TEAM_SESSION: session,
			TEAM_OWNER_PID: `${process.pid}`,
			TEAM_BUSY_FILE: busyFile,
		};
		// The client exits on stdin EOF, so the pipe must be owned by
		// this process: closing it (when pi goes away) drops the
		// endpoint instead of leaving an orphan pinging forever.
		this.holdProc = this.launch(
			python,
			[teamBin, "--root", stateRoot, "hold"],
			{ env, stdio: ["pipe", "ignore", "ignore"] },
		);
	}

	stopHold(): void {
		const proc = this.holdProc;
		this.holdProc = null;
		if (!proc) return;
		try {
			proc.stdin?.end();
		} catch {
			// already closed
		}
		try {
			proc.kill();
		} catch {
			// already gone
		}
	}

	setBusy(busy: boolean): void {
		// The model's own lifecycle publishes busyness so the broker's
		// fork idle GC keeps a working teammate alive.
		try {
			writeFileSync(`${stateRoot}/${this.id}.busy`, busy ? "1" : "0");
		} catch {
			// best effort: without the flag the fork is GC'd like an idle one
		}
	}

	async snapshot(): Promise<AgentInfo[]> {
		const result = await this.exec(
			python,
			[teamBin, "--root", stateRoot, "ls"],
			{ timeout: 3000 },
		);
		try {
			const parsed = JSON.parse(result.stdout as string);
			return (parsed.agents || []) as AgentInfo[];
		} catch {
			return [];
		}
	}

	async send(to: string, kind: string, text: string): Promise<string> {
		const result = await this.exec(
			python,
			[teamBin, "--root", stateRoot, "send", to, kind, text],
			{ timeout: 3000 },
		);
		return String(result.stdout).trim();
	}

	async terminate(agentId: string): Promise<void> {
		await this.exec(
			python,
			[teamBin, "--root", stateRoot, "terminate", agentId],
			{ timeout: 3000 },
		);
	}

	parseSpawn(rest: string): SpawnRequest {
		const trimmed = (rest || "").trim();
		const nameMatch = /^--name\s+(\S+)/.exec(trimmed);
		const name = nameMatch ? nameMatch[1] : "";
		// The argv separator is a standalone "--"; the leading "--" of
		// "--name" must never be mistaken for it.
		const sep = /(?:^|\s)--(?:\s|$)/.exec(trimmed);
		let argv: string[] = [];
		if (sep) {
			const after = trimmed.slice(sep.index + sep[0].length).trim();
			argv = after ? after.split(/\s+/).filter(Boolean) : [];
		}
		return { name, argv };
	}

	spawn(name: string, argv: string[]): void {
		const forkId =
			`fork-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
		const invocation = piInvocation();
		const args = argv.length
			? argv
			: ["--no-session", "-p",
				"You are a teammate of the agent that forked you. " +
				"Check /team ls for teammates and use /team send " +
				"to coordinate."];
		const env = {
			...process.env,
			TEAM_ID: forkId,
			TEAM_NAME: name || forkId,
			TEAM_ROLE: "fork",
			TEAM_PARENT_ID: this.id,
			TEAM_SESSION: process.env.PI_SESSION_FILE || "",
			PI_SESSION_FILE: process.env.PI_SESSION_FILE || "",
		};
		this.ensureBroker();
		// The child is its own pi; detach it so the broker, not process
		// parentage, owns its lifetime. The environment carries the fork
		// identity that pi.exec would have dropped.
		const child = this.launch(
			invocation.command,
			[...invocation.args, ...args],
			{ env, detached: true, stdio: "ignore", windowsHide: true },
		);
		child?.unref();
	}

	deregister(): void {
		this.stopHold();
	}

	announce(agents: AgentInfo[]): { customType: string; content: string; display: boolean } | null {
		if (this.announced) return null;
		this.announced = true;
		const lines = agents
			.slice(0, 8)
			.map((a) =>
				`- ${a.id} ${a.name} (${a.role}, ${a.online ? "online" : "offline"}): ` +
				`/team send ${a.id} text <message>`);
		const content =
			`## pi-teams teammates (broker: ${stateRoot})\n` +
			`${lines.join("\n") || "- none live yet"}\n` +
			`Spawn a teammate that dies with you: /team spawn --name <n> -- <pi args>` +
			`; list: /team ls; send: /team send <id> <kind> <text>.`;
		return { customType: "pi-teams", content, display: false };
	}
}

export default function (pi: ExtensionAPI) {
	const app = new TeamAgent((file, args, options) => pi.exec(file, args, options));

	pi.on("session_start", async (_event, ctx) => {
		app.ensureBroker();
		app.hold(ctx.cwd);
	});

	pi.on("agent_start", async () => {
		app.setBusy(true);
	});

	pi.on("agent_settled", async () => {
		app.setBusy(false);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const agents = await app.snapshot();
		const note = app.announce(agents);
		if (note) return { message: note };
	});

	pi.on("session_shutdown", async () => {
		app.deregister();
	});

	pi.registerCommand("team", {
		description:
			"pi-teams: ls|status|send <id> [kind] <text>|spawn [--name N] [-- argv...]|kill <id>",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const sub = parts.shift() || "status";
			const rest = parts.join(" ");
			if (sub === "ls" || sub === "status") {
				const agents = await app.snapshot();
				const lines = agents.map((a) =>
					`${a.id}\t${a.name}\t${a.role}\t${a.online ? "online" : "offline"}` +
					(a.parent ? `\tchild-of ${a.parent}` : ""));
				ctx.ui.notify(
					`pi-teams: ${agents.length} agent(s)\n${lines.join("\n")}`,
					"info",
				);
				return;
			}
			if (sub === "send") {
				const m = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/.exec(rest);
				if (!m || !m[1] || !m[3]) {
					ctx.ui.notify("usage: /team send <id> [kind] <text>", "warning");
					return;
				}
				const reply = await app.send(
					m[1], m[2] || "text", m[3]);
				ctx.ui.notify(`pi-teams: ${reply}`, "info");
				return;
			}
			if (sub === "spawn") {
				const { name, argv } = app.parseSpawn(rest);
				app.spawn(name, argv);
				ctx.ui.notify(
					`pi-teams: spawned ${name || "fork"} ` +
					`(${argv.length ? argv.join(" ") : "default teammate"})`,
					"info",
				);
				return;
			}
			if (sub === "kill") {
				const target = rest.trim();
				if (!target) {
					ctx.ui.notify("usage: /team kill <id>", "warning");
					return;
				}
				await app.terminate(target);
				ctx.ui.notify(`pi-teams: terminated ${target}`, "info");
				return;
			}
			ctx.ui.notify(
				"pi-teams: subcommands: ls | status | send <id> [kind] " +
				"<text> | spawn [--name N] [-- argv...] | kill <id>",
				"warning",
			);
		},
	});
}
