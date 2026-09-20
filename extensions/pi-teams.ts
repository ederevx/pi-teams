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
 * A spawned teammate is a normal pi session: it is named and stored in
 * the parent's session directory, so it appears in `/resume` after the
 * hold's GC reaps its process. Only the process is tied to the parent;
 * the session file survives for later resumption.
 *
 * The broker and client live in the pi-teams repository and are expected
 * at $HOME/.local/bin (or PI_TEAMS_BIN). The extension owns the whole
 * teammate launch; there is intentionally no way to override the pi
 * command or inject a custom spawn argv.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const home = homedir();
const stateRoot =
	process.env.TEAM_ROOT ||
	join(process.env.XDG_STATE_HOME || join(home, ".local", "state"),
		"pi-teams");
const binDir = process.env.PI_TEAMS_BIN || join(home, ".local", "bin");
/** Resolves a Python interpreter without a platform branch: an explicit
 *  PYTHON wins, otherwise the first of python3/python/py that answers
 *  (py is the launcher on Windows). */
function resolvePython(): string {
	if (process.env.PYTHON) return process.env.PYTHON;
	for (const candidate of ["python3", "python", "py"]) {
		try {
			if (spawnSync(candidate, ["--version"], {
				stdio: "ignore", windowsHide: true,
			}).status === 0) {
				return candidate;
			}
		} catch {
			// try the next candidate
		}
	}
	return "python3";
}
const teamdBin = join(binDir, "teamd");
const teamBin = join(binDir, "team");

/**
 * How to launch another pi without a shell. Reusing the running runtime
 * avoids spawning a Windows launcher shim (pi.cmd/pi.ps1) directly,
 * which child_process cannot execute; pi's own subagent helper resolves
 * it the same way. This is the only launch path for teammates.
 */
function piInvocation(): { command: string; args: string[] } {
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
	session: string | null;
	online: boolean;
}

interface SpawnedProcess {
	stdin: { end(): void; write(data: string): void } | null;
	stdout: { on(event: string, listener: (chunk: unknown) => void): void } | null;
	on(event: string, listener: () => void): void;
	unref(): void;
	kill(): void;
}

export interface TeamMessage {
	from: string;
	to: string;
	kind: string;
	payload: unknown;
	ts?: number;
}

type ExecFn = (file: string, args: string[], options?: object) => Promise<unknown>;
type SpawnFn = (
	file: string,
	args: string[],
	options?: Record<string, unknown>,
) => SpawnedProcess;
type DeliverFn = (message: TeamMessage) => void;

export interface SpawnOptions {
	provider?: string;
	model?: string;
	thinking?: string;
	/** "fresh" (default) starts a clean context and never carries the
	 *  parent's history; "inherit" forks the parent session so the
	 *  teammate can reuse its warm prompt-cache prefix. */
	context?: "fresh" | "inherit";
}

export interface TeammateRef {
	id: string;
	session: string;
}

export class TeamAgent {
	readonly exec: ExecFn;
	private readonly spawnProcess: SpawnFn;
	private readonly deliver: DeliverFn;
	private readonly python: string;
	id: string = "";
	private announced = false;
	private holdProc: SpawnedProcess | null = null;
	private readonly teammates = new Set<SpawnedProcess>();
	private sessionFile = "";
	private sessionDir = "";

	constructor(exec: ExecFn, spawnProcess: SpawnFn = nodeSpawn, deliver: DeliverFn = () => {}) {
		this.exec = exec;
		this.spawnProcess = spawnProcess;
		this.deliver = deliver;
		this.python = resolvePython();
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
		if (existsSync(join(stateRoot, "endpoint"))) return;
		// The broker never exits; detach it so it outlives the session
		// that happened to start it.
		const child = this.launch(
			this.python,
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
		const session = this.sessionFile;
		const busyFile = join(stateRoot, `${this.id}.busy`);
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
		// endpoint instead of leaving an orphan pinging forever. Its
		// stdout carries inbound messages for the agent.
		const proc = this.launch(
			this.python,
			[teamBin, "--root", stateRoot, "hold"],
			{ env, stdio: ["pipe", "pipe", "ignore"] },
		);
		this.holdProc = proc;
		if (proc?.stdout) this.forwardMessages(proc.stdout);
	}

	private forwardMessages(
		stdout: { on(event: string, listener: (chunk: unknown) => void): void },
	): void {
		let buffer = "";
		stdout.on("data", (chunk) => {
			buffer += String(chunk);
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) this.deliverMessage(line);
				newline = buffer.indexOf("\n");
			}
		});
	}

	private deliverMessage(line: string): void {
		try {
			this.deliver(JSON.parse(line) as TeamMessage);
		} catch {
			// The hold prints one JSON object per line; a malformed line
			// is dropped rather than crashing the session.
		}
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
			writeFileSync(join(stateRoot, `${this.id}.busy`), busy ? "1" : "0");
		} catch {
			// best effort: without the flag the fork is GC'd like an idle one
		}
	}

	async snapshot(): Promise<AgentInfo[]> {
		const result = await this.exec(
			this.python,
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
			this.python,
			[teamBin, "--root", stateRoot, "send", to, kind, text],
			{ timeout: 3000 },
		);
		return String(result.stdout).trim();
	}

	async terminate(agentId: string): Promise<void> {
		await this.exec(
			this.python,
			[teamBin, "--root", stateRoot, "terminate", agentId],
			{ timeout: 3000 },
		);
	}

	/** The common teammate template: the caller supplies only the task and
	 *  an optional name; session, model, and the report-back instruction
	 *  are supplied here. */
	spawnTask(name: string, task: string, options: SpawnOptions = {}): TeammateRef {
		const forkId = this.makeForkId();
		const session = name || forkId;
		const inherit = options.context === "inherit";
		if (inherit && !this.sessionFile) {
			throw new Error(
				"cannot inherit context: this session has no file to fork");
		}
		// The teammate is a persistent headless pi session, not a one-shot
		// `pi -p` task: the extension owns the whole launch and delivers the
		// task as an RPC prompt, so the teammate stays alive to be messaged.
		const args = [
			"--mode", "rpc",
			...(inherit ? ["--fork", this.sessionFile] : []),
			...(this.sessionDir ? ["--session-dir", this.sessionDir] : []),
			"--name", session,
			...(options.provider ? ["--provider", options.provider] : []),
			...(options.model ? ["--model", options.model] : []),
			...(options.thinking ? ["--thinking", options.thinking] : []),
		];
		this.launchTeammate(forkId, session, args, this.taskPrompt(session, task));
		return { id: forkId, session };
	}

	private makeForkId(): string {
		return `fork-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
	}

	private taskPrompt(session: string, task: string): string {
		// Call the interpreter on the absolute client path instead of a
		// `team` name on PATH: a shebang script is not executable on
		// Windows, and binDir may not be on PATH. The teammate runs this
		// through its shell tool, where the $TEAM_* variables expand.
		const send =
			`"${this.python}" "${teamBin}" --root "$TEAM_ROOT" ` +
			`send "$TEAM_PARENT_ID" result "<report>"`;
		return (
			`You are "${session}", a teammate spawned by a parent pi session ` +
			`to do one task. Do the task, then report the outcome to your ` +
			`parent by running this command:\n  ${send}\n` +
			`Do not write memory. Task:\n${task}`
		);
	}

	private launchTeammate(
		forkId: string,
		session: string,
		args: string[],
		prompt: string,
	): void {
		const invocation = piInvocation();
		// A teammate is its own root session, not a nested view of the
		// parent: drop every inherited variable that binds a process to a
		// parent session or host, whichever layer set it, then hand the
		// child this fork's own identity below. Pi removes its session
		// variables for child shells the same way.
		const env: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(env)) {
			if (/^(PI|TEAM)_(SESSION|HOST)/.test(key)) delete env[key];
		}
		Object.assign(env, {
			TEAM_ID: forkId,
			TEAM_NAME: session,
			TEAM_ROLE: "fork",
			TEAM_PARENT_ID: this.id,
			TEAM_ROOT: stateRoot,
		});
		this.ensureBroker();
		// The extension holds the teammate's RPC stdin open: the teammate
		// stays alive for messages and exits when this pi goes away (the
		// pipe closes) or the broker GC signals it.
		const child = this.launch(
			invocation.command,
			[...invocation.args, ...args],
			{ env, detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
		);
		if (!child) return;
		this.teammates.add(child);
		child.on("exit", () => this.teammates.delete(child));
		if (child.stdin) {
			try {
				child.stdin.write(
					JSON.stringify({ type: "prompt", message: prompt }) + "\n");
			} catch {
				// The teammate died before the prompt landed; the broker GC
				// reaps the entry.
			}
		}
		child.unref();
	}

	private stopTeammates(): void {
		for (const child of this.teammates) {
			try {
				child.stdin?.end();
			} catch {
				// already closed
			}
			try {
				child.kill();
			} catch {
				// already gone
			}
		}
		this.teammates.clear();
	}

	sessionDirLabel(): string {
		return this.sessionDir || "the default session store";
	}

	/** Tells the parent which session this fork came up as, so the parent
	 *  can name it without polling the broker. */
	async announceSession(sessionFile: string | null | undefined): Promise<void> {
		const parent = process.env.TEAM_PARENT_ID;
		if (!parent || !sessionFile) return;
		try {
			await this.send(parent, "notice", `session ${sessionFile}`);
		} catch {
			// Broker unavailable; the registry still records the session.
		}
	}

	deregister(): void {
		this.stopHold();
		this.stopTeammates();
	}

	rememberSession(sessionFile?: string): void {
		// The session file comes from ctx.sessionManager at session start,
		// not the environment: pi only exposes PI_SESSION_FILE to shell
		// tools, and it can be absent or stale in a fresh session.
		this.sessionFile = sessionFile || "";
		this.sessionDir = this.sessionFile ? dirname(this.sessionFile) : "";
	}

	announce(agents: AgentInfo[]): { customType: string; content: string; display: boolean } | null {
		if (this.announced) return null;
		this.announced = true;
		const lines = agents
			.slice(0, 8)
			.map((a) =>
				`- ${a.id} ${a.name} (${a.role}, ${a.online ? "online" : "offline"}` +
				(a.session ? `, session ${basename(a.session)}` : "") +
				`): /team send ${a.id} text <message>`);
		const content =
			`## pi-teams teammates (broker: ${stateRoot})\n` +
			`${lines.join("\n") || "- none live yet"}\n` +
			`Spawn a teammate that lives in its own session: team_spawn ` +
			`(task, name); list: /team ls; send: /team send <id> <kind> <text>.`;
		return { customType: "pi-teams", content, display: false };
	}
}

/** Records a one-line, truncated log entry for a team message. The
 *  renderer below shows the preview, or the full payload when expanded. */
export function logTeamMessage(
	pi: ExtensionAPI,
	direction: "sent" | "received",
	message: TeamMessage,
): void {
	const payload =
		typeof message.payload === "string"
			? message.payload
			: JSON.stringify(message.payload);
	const preview = payload.length > 96
		? `${payload.slice(0, 93)}...`
		: payload;
	pi.appendEntry("pi-teams-log", {
		direction,
		from: message.from,
		to: message.to,
		kind: message.kind,
		preview,
		payload,
	});
}

/** Surfaces an inbound team message to the agent as a custom message.
 *  Registered as the TeamAgent's deliver callback. */
function deliverToAgent(pi: ExtensionAPI, message: TeamMessage): void {
	logTeamMessage(pi, "received", message);
	// A notice is bookkeeping (for example a teammate announcing its
	// session); record it without forcing a model turn.
	if (message.kind === "notice") return;
	const payload =
		typeof message.payload === "string"
			? message.payload
			: JSON.stringify(message.payload);
	void pi.sendMessage(
		{
			customType: "pi-teams",
			content: `pi-teams ${message.kind} from ${message.from}:\n${payload}`,
			display: true,
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

export default async function (pi: ExtensionAPI) {
	const app = new TeamAgent(
		(file, args, options) => pi.exec(file, args, options),
		undefined,
		(message) => deliverToAgent(pi, message),
	);

	pi.registerEntryRenderer("pi-teams-log", (entry, options, theme) => {
		const data = entry.data as {
			direction?: string;
			from?: string;
			kind?: string;
			preview?: string;
			payload?: string;
		} | undefined;
		const arrow = data?.direction === "sent" ? "->" : "<-";
		const head = `[pi-teams] ${arrow} ${data?.from ?? "?"} ` +
			`(${data?.kind ?? "text"})`;
		const lines = options.expanded && data?.payload
			? [theme.fg("dim", head)]
				.concat(data.payload.split("\n").map((line) =>
					theme.fg("dim", `  ${line}`)))
			: [theme.fg("dim", `${head}: ${data?.preview ?? ""}`)];
		return { render: () => lines, invalidate() {} };
	});

	// -- agent-facing teammate spawn -------------------------------------
	// The teammate template lives here: the agent names a task and gets a
	// separate, resumable pi session back. No wrapper script or command
	// line is needed.
	const { Type } = await import("typebox");
	pi.registerTool({
		name: "team_spawn",
		label: "spawn teammate",
		description:
			"Spawn a pi-teams teammate that runs in its own persistent, " +
			"resumable pi session and reports its result back as a team " +
			"message. Give it exactly one task. The teammate is fresh by " +
			"default (smallest context and cost); set context to inherit " +
			"only when the task depends on this conversation, which forks " +
			"the parent session and can reuse its warm prompt cache.",
		promptSnippet:
			"Spawn a pi-teams teammate to do a task in its own session",
		promptGuidelines: [
			"Use team_spawn to delegate a bounded task to a teammate: it " +
				"runs as a separate pi session with its own /resume entry and " +
				"sends its result back as a pi-teams message. Pass a " +
				"self-contained task; only set context=inherit when the " +
				"teammate must see this conversation.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The task the teammate must do" }),
			name: Type.Optional(Type.String({
				description: "Teammate and session name",
			})),
			context: Type.Optional(Type.Union([
				Type.Literal("fresh"),
				Type.Literal("inherit"),
			], {
				description:
					"fresh (default) starts clean; inherit forks this " +
					"conversation so a context-dependent task can reuse its " +
					"warm prompt cache",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const model = ctx?.model;
			const ref = app.spawnTask(params.name || "", params.task, {
				provider: model?.provider,
				model: model?.id,
				thinking: ctx?.thinkingLevel,
				context: params.context,
			});
			return {
				content: [{
					type: "text",
					text: `spawned teammate ${ref.id} as session ` +
						`"${ref.session}"; it reports back as a pi-teams message.`,
				}],
				details: ref,
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		app.ensureBroker();
		const sessionFile = ctx.sessionManager.getSessionFile();
		app.rememberSession(sessionFile);
		app.hold(ctx.cwd);
		void app.announceSession(sessionFile);
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
			"pi-teams: ls|status|send <id> [kind] <text>|kill <id>",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const sub = parts.shift() || "status";
			const rest = parts.join(" ");
			if (sub === "ls" || sub === "status") {
				const agents = await app.snapshot();
				const lines = agents.map((a) =>
					`${a.id}\t${a.name}\t${a.role}\t${a.online ? "online" : "offline"}` +
					(a.parent ? `\tchild-of ${a.parent}` : "") +
					(a.session ? `\tsession ${basename(a.session)}` : ""));
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
				const kind = m[2] || "text";
				const reply = await app.send(m[1], kind, m[3]);
				logTeamMessage(pi, "sent", {
					from: app.id, to: m[1], kind, payload: m[3],
				});
				ctx.ui.notify(`pi-teams: ${reply}`, "info");
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
				"<text> | kill <id>",
				"warning",
			);
		},
	});
}
