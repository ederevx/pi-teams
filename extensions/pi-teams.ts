/**
 * pi-teams - cross-pi-agent communication and self-forks.
 *
 * On session start this extension registers the running pi process with
 * the team broker (src/teamd.py) through a held connection, so the agent
 * gains an endpoint other agents can reach. A compact awareness note is
 * injected before the first agent run listing live teammates and the
 * commands used to reach or spawn them. A spawned fork runs a pi process
 * whose environment names this agent as its parent; the broker
 * terminates the fork when the parent process dies, so teammates cannot
 * outlive the agent that spawned them.
 *
 * The broker and client live in the pi-teams repository and are expected
 * at TEAM_ROOT (~/.local/state/pi-teams) and $HOME/.local/bin (or
 * PI_TEAMS_BIN). Override the pi binary for forks with PI_TEAMS_PI.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

const home = process.env.HOME || ".";
const stateRoot =
	process.env.TEAM_ROOT ||
	`${process.env.XDG_STATE_HOME || `${home}/.local/state`}/pi-teams`;
const binDir = process.env.PI_TEAMS_BIN || `${home}/.local/bin`;
const python = process.env.PYTHON || "python3";
const teamdBin = `${binDir}/teamd`;
const teamBin = `${binDir}/team`;
const piBin = process.env.PI_TEAMS_PI || "pi";

interface AgentInfo {
	id: string;
	name: string;
	role: string;
	pid: number;
	parent: string | null;
	online: boolean;
}

class TeamAgent {
	readonly exec: (file: string, args: string[], options?: object) => Promise<unknown>;
	id: string = "";
	private announced = false;

	constructor(
		exec: (file: string, args: string[], options?: object) => Promise<unknown>,
	) {
		this.exec = exec;
		this.id = process.env.TEAM_ID ||
			`pi-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
	}

	ensureBroker(): void {
		if (existsSync(`${stateRoot}/teamd.sock`)) return;
		// The broker never exits; fire and forget so the session stays
		// responsive. It is reaped by pidfile at `teamd stop`.
		void this.exec(python, [teamdBin, "--root", stateRoot, "start"]);
	}

	hold(cwd?: string): void {
		const env = {
			TEAM_ID: this.id,
			TEAM_NAME: process.env.TEAM_NAME || `pi@${cwd || process.cwd()}`,
			TEAM_ROLE: process.env.TEAM_ID ? "fork" : "main",
			TEAM_PARENT_ID: process.env.TEAM_PARENT_ID || "",
			TEAM_PID: `${process.pid}`,
			TEAM_WATCH_PID: `${process.pid}`,
			TEAM_SESSION: process.env.PI_SESSION_FILE || "",
		};
		void this.exec(python, [teamBin, "--root", stateRoot, "child", "hold"], {
			env,
		});
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

	spawn(name: string, argv: string[]): void {
		const env = {
			TEAM_ID: `fork-${process.pid}-${Math.random().toString(16).slice(2, 10)}`,
			TEAM_NAME: name || `fork-${process.pid}`,
			TEAM_ROLE: "fork",
			TEAM_PARENT_ID: this.id,
			TEAM_PID: "",
			TEAM_WATCH_PID: "",
			PI_SESSION_FILE: process.env.PI_SESSION_FILE || "",
		};
		const args = argv.length
			? argv
			: [piBin, "--no-session", "-p",
				"You are a teammate of the agent that forked you. " +
				"Check /team ls for teammates and use /team send " +
				"to coordinate."];
		this.ensureBroker();
		void this.exec(args[0], args.slice(1), { env });
	}

	deregister(): void {
		void this.exec(python, [teamBin, "--root", stateRoot, "deregister"], {
			env: { TEAM_ID: this.id, TEAM_PID: `${process.pid}` },
		});
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
				const nameMatch = /^--name\s+(\S+)/.exec(rest);
				const name = nameMatch ? nameMatch[1] : undefined;
				const argvIndex = rest.indexOf("--");
				const argv = argvIndex >= 0
					? rest.slice(argvIndex + 2).trim().split(/\s+/).filter(Boolean)
					: [];
				app.spawn(name || "", argv);
				ctx.ui.notify(
					`pi-teams: spawned ${name || "fork"} ` +
					`(${argv.length ? argv.join(" ") : piBin})`,
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