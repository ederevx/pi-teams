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
import { createServer } from "node:net";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
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

/** Default bound for team_wait, overridable with PI_TEAMS_WAIT. */
const DEFAULT_WAIT_SECONDS = 300;

/** Resolves the team_wait bound from the call, then the environment. */
function waitSeconds(requested?: number): number {
	if (typeof requested === "number" && requested > 0) return requested;
	const env = Number(process.env.PI_TEAMS_WAIT);
	return Number.isFinite(env) && env > 0 ? env : DEFAULT_WAIT_SECONDS;
}

/** Resolves a free loopback port for an SSH local forward. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address
				? address.port
				: 0;
			server.close(() => resolve(port));
		});
	});
}

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
	origin?: string;
	remote?: boolean;
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

export class TeamAgent {
	readonly exec: ExecFn;
	private readonly spawnProcess: SpawnFn;
	private readonly deliver: DeliverFn;
	private readonly python: string;
	id: string = "";
	private announced = false;
	private holdProc: SpawnedProcess | null = null;
	private readonly teammates = new Set<SpawnedProcess>();
	private readonly tunnels = new Set<SpawnedProcess>();
	private readonly waiters =
		new Map<string, Set<(message: TeamMessage | null) => void>>();
	private readonly recentResults = new Map<string, TeamMessage>();
	private readonly pendingSpawns =
		new Map<string, (ref: TeammateRef | null) => void>();
	readonly host: string;
	private sessionFile = "";
	private sessionDir = "";

	constructor(exec: ExecFn, spawnProcess: SpawnFn = nodeSpawn, deliver: DeliverFn = () => {}) {
		this.exec = exec;
		this.spawnProcess = spawnProcess;
		this.deliver = deliver;
		this.python = resolvePython();
		this.host = process.env.PI_TEAMS_HOST || hostname().split(".")[0];
		this.id =
			process.env.TEAM_ID ||
			`${this.host}:pi-${process.pid}-` +
			Math.random().toString(16).slice(2, 10);
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
		const busyFile = this.busyFile();
		const env = this.holdEnv(name, role, parent, busyFile);
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

	/** The hold's environment: this agent's identity plus the busy file
	 *  the heartbeat reads for its run-state. */
	private holdEnv(
		name: string,
		role: string,
		parent: string,
		busyFile: string,
	): Record<string, string | undefined> {
		return {
			...process.env,
			TEAM_ID: this.id,
			TEAM_NAME: name,
			TEAM_ROLE: role,
			TEAM_PARENT_ID: parent,
			TEAM_SESSION: this.sessionFile,
			TEAM_OWNER_PID: `${process.pid}`,
			TEAM_BUSY_FILE: busyFile,
		};
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
		let message: TeamMessage;
		try {
			message = JSON.parse(line) as TeamMessage;
		} catch {
			// The hold prints one JSON object per line; a malformed line
			// is dropped rather than crashing the session.
			return;
		}
		if (message.kind === "spawn-ack" || message.kind === "spawn-error") {
			this.resolveSpawn(message);
			return;
		}
		if (message.kind === "spawn") {
			this.handleSpawnRequest(message);
			return;
		}
		if (message.kind !== "result" || message.to !== this.id) {
			this.deliver(message);
			return;
		}
		// A pending wait consumes the awaited result and surfaces it as the
		// tool's result, so it is not also delivered as a steered turn.
		const waiting = this.waiters.get(message.from);
		if (waiting && waiting.size > 0) {
			this.waiters.delete(message.from);
			for (const settle of waiting) settle(message);
			return;
		}
		// Nobody is waiting yet: remember it so a wait that starts just
		// after the report returns it instead of timing out, and deliver it
		// the ordinary way for an agent that was not waiting at all.
		this.recentResults.set(message.from, message);
		this.deliver(message);
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
		this.setState(busy ? "busy" : "idle");
	}

	/** Publishes the agent's run-state for the broker: busy keeps a fork
	 *  alive, idle does not, and waiting is not-working while an in-flight
	 *  team_wait keeps the fork exempt from idle GC. */
	setState(state: "busy" | "idle" | "waiting"): void {
		const value = state === "busy" ? "1" : state === "waiting" ? "2" : "0";
		try {
			writeFileSync(this.busyFile(), value);
		} catch {
			// best effort: without the flag the fork is GC'd like an idle one
		}
	}

	/** This agent's state file. The id carries a host label, whose colon
	 *  is illegal in a Windows filename, so the id is sanitized. */
	private busyFile(): string {
		const safe = this.id.replace(/[^A-Za-z0-9._-]/g, "-");
		return join(stateRoot, `${safe}.busy`);
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

	/** Blocks until the awaited teammate (by id) sends a `result`, the
	 *  bound elapses, or the signal aborts; resolves null in the latter
	 *  two. A result that already arrived is returned at once. Several
	 *  waits for one teammate all resolve on its single result. */
	async waitForResult(
		agentId: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<TeamMessage | null> {
		const buffered = this.recentResults.get(agentId);
		if (buffered) {
			this.recentResults.delete(agentId);
			return buffered;
		}
		// A bound of zero still cannot hang: fall back to the default.
		const effective = timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_SECONDS * 1000;
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (message: TeamMessage | null): void => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				const set = this.waiters.get(agentId);
				if (set) {
					set.delete(settle);
					if (set.size === 0) this.waiters.delete(agentId);
				}
				resolve(message);
			};
			const onAbort = (): void => settle(null);
			const set = this.waiters.get(agentId) ?? new Set();
			set.add(settle);
			this.waiters.set(agentId, set);
			timer = setTimeout(() => settle(null), effective);
			if (signal) {
				if (signal.aborted) settle(null);
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	/** Waits for every listed teammate; each entry resolves to its result
	 *  or null on timeout/abort. One signal and bound cover them all. */
	async waitForResults(
		agentIds: string[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Map<string, TeamMessage | null>> {
		const results = await Promise.all(
			agentIds.map((id) => this.waitForResult(id, timeoutMs, signal)));
		return new Map(agentIds.map((id, i) => [id, results[i]]));
	}

	/** Asks a peer host's main agent to spawn a teammate, and returns the
	 *  new id once it answers. The peer host owns the process and session;
	 *  this agent only requested the work. */
	async spawnRemote(
		host: string,
		name: string,
		task: string,
	): Promise<TeammateRef | null> {
		const agents = await this.snapshot();
		const own = (a: AgentInfo): boolean =>
			a.origin === host || a.id.startsWith(`${host}:`);
		const target = agents.find((a) => own(a) && a.role === "main")
			?? agents.find(own);
		if (!target) return null;
		const requestId =
			`spawn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
		const pending = this.waitForSpawn(requestId, 15000);
		await this.send(target.id, "spawn", JSON.stringify({
			task, name, requestId,
		}));
		return pending;
	}

	private waitForSpawn(
		requestId: string,
		timeoutMs: number,
	): Promise<TeammateRef | null> {
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (ref: TeammateRef | null): void => {
				if (timer) clearTimeout(timer);
				this.pendingSpawns.delete(requestId);
				resolve(ref);
			};
			this.pendingSpawns.set(requestId, settle);
			timer = setTimeout(() => settle(null), timeoutMs);
		});
	}

	private resolveSpawn(message: TeamMessage): void {
		const payload = (message.payload ?? {}) as {
			requestId?: string; id?: string; session?: string;
		};
		if (!payload.requestId) return;
		const settle = this.pendingSpawns.get(payload.requestId);
		if (!settle) return;
		this.pendingSpawns.delete(payload.requestId);
		if (message.kind === "spawn-ack" && payload.id) {
			settle({ id: payload.id, session: payload.session || payload.id });
		} else {
			settle(null);
		}
	}

	/** A peer host asked this agent to spawn a teammate: this host owns
	 *  the process and session and reports the new id back. */
	private handleSpawnRequest(message: TeamMessage): void {
		const payload = (message.payload ?? {}) as {
			task?: string; name?: string; requestId?: string;
		};
		if (!payload.task) return;
		try {
			const ref = this.spawnTask(payload.name || "", payload.task, {
				parent: message.from,
			});
			void this.send(message.from, "spawn-ack", JSON.stringify({
				requestId: payload.requestId, id: ref.id,
				session: ref.session,
			}));
		} catch {
			void this.send(message.from, "spawn-error", JSON.stringify({
				requestId: payload.requestId,
			}));
		}
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
		const args = this.teammateArgs(session, options, inherit);
		this.launchTeammate(forkId, session, args,
			this.taskPrompt(session, task), options.parent);
		return { id: forkId, session };
	}

	/** The spawn argv for a teammate: a headless RPC session, not a
	 *  one-shot `pi -p`, that inherits the parent's session directory,
	 *  provider, model, and thinking level. */
	private teammateArgs(
		session: string,
		options: SpawnOptions,
		inherit: boolean,
	): string[] {
		return [
			"--mode", "rpc",
			...(inherit ? ["--fork", this.sessionFile] : []),
			...(this.sessionDir ? ["--session-dir", this.sessionDir] : []),
			"--name", session,
			...(options.provider ? ["--provider", options.provider] : []),
			...(options.model ? ["--model", options.model] : []),
			...(options.thinking ? ["--thinking", options.thinking] : []),
		];
	}

	private makeForkId(): string {
		return `${this.host}:fork-${process.pid}-` +
			Math.random().toString(16).slice(2, 10);
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
		parent?: string,
	): void {
		const invocation = piInvocation();
		const env = this.teammateEnv(forkId, session, parent);
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

	/** A teammate's environment: drop every inherited variable that binds
	 *  a process to a parent session or host, whichever layer set it,
	 *  then set the fork's own identity. Pi removes its session variables
	 *  for child shells the same way. */
	private teammateEnv(
		forkId: string,
		session: string,
		parent?: string,
	): Record<string, string | undefined> {
		const env: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(env)) {
			if (/^(PI|TEAM)_(SESSION|HOST)/.test(key)) delete env[key];
		}
		Object.assign(env, {
			TEAM_ID: forkId,
			TEAM_NAME: session,
			TEAM_ROLE: "fork",
			TEAM_PARENT_ID: parent || this.id,
			TEAM_ROOT: stateRoot,
		});
		return env;
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

	private stopTunnels(): void {
		for (const tunnel of this.tunnels) {
			try {
				tunnel.kill();
			} catch {
				// already gone
			}
		}
		this.tunnels.clear();
	}

	/** Links a peer host's loopback broker: read its endpoint read-only
	 *  over the existing SSH session, open a loopback-only ssh -L tunnel
	 *  to it, and tell the local broker to peer. Returns the peer label. */
	async peerAdd(sshTarget: string, label: string): Promise<string> {
		const remoteState = process.env.PI_TEAMS_REMOTE_STATE
			|| "$HOME/.local/state/pi-teams";
		const result = await this.exec(
			"ssh", [sshTarget, "cat", `${remoteState}/endpoint`]);
		const endpoint = JSON.parse(String(result.stdout).trim()) as {
			port: number; token: string; name?: string;
		};
		const peer = label || endpoint.name || sshTarget;
		const port = await freePort();
		const tunnel = this.launch("ssh", [
			"-N", "-L",
			`127.0.0.1:${port}:127.0.0.1:${endpoint.port}`,
			sshTarget,
		], { stdio: "ignore", windowsHide: true, detached: true });
		if (tunnel) {
			this.tunnels.add(tunnel);
			tunnel.on("exit", () => this.tunnels.delete(tunnel));
			tunnel.unref();
		}
		await this.exec(this.python, [
			teamBin, "--root", stateRoot, "peer", "add", peer,
			`127.0.0.1:${port}:${endpoint.token}`,
		]);
		return peer;
	}

	async peerRemove(host: string): Promise<void> {
		await this.exec(this.python, [
			teamBin, "--root", stateRoot, "peer", "remove", host,
		]);
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

	private cancelWaits(): void {
		for (const set of [...this.waiters.values()]) {
			for (const settle of [...set]) settle(null);
		}
		this.waiters.clear();
		this.recentResults.clear();
		for (const settle of [...this.pendingSpawns.values()]) settle(null);
		this.pendingSpawns.clear();
	}

	deregister(): void {
		this.cancelWaits();
		this.stopHold();
		this.stopTeammates();
		this.stopTunnels();
		this.clearState();
	}

	/** Removes this agent's state file so stale busy flags do not
	 *  accumulate in the team root across sessions. */
	private clearState(): void {
		try {
			unlinkSync(this.busyFile());
		} catch {
			// no state file to remove
		}
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
			`(task, name); block for one or more reports with team_wait ` +
			`(ids), or let them arrive as messages. Peer hosts: team_peer ` +
			`add <ssh-host>, then team_spawn host=<label>. list: ` +
			`/team ls; send: /team send <id> <kind> <text>.`;
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
			"message. Give it exactly one task. Wait for the report with " +
			"team_wait when you want to block; otherwise keep working and " +
			"the report arrives as a pi-teams message. The teammate is fresh " +
			"by default (smallest context and cost); set context to inherit " +
			"only when the task depends on this conversation, which forks " +
			"the parent session and can reuse its warm prompt cache.",
		promptSnippet:
			"Spawn a pi-teams teammate to do a task in its own session",
		promptGuidelines: [
			"Use team_spawn to delegate a bounded task to a teammate: it " +
				"runs as a separate pi session with its own /resume entry and " +
				"sends its result back as a pi-teams message. Pass a " +
				"self-contained task; only set context=inherit when the " +
				"teammate must see this conversation. Call team_wait to block " +
				"for the report when you want to, or continue with other work " +
				"and let it arrive as a pi-teams message.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The task the teammate must do" }),
			name: Type.Optional(Type.String({
				description: "Teammate and session name",
			})),
			host: Type.Optional(Type.String({
				description:
					"Peer host label to spawn on; defaults to this host",
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
			const remote = params.host && params.host !== app.host
				? params.host
				: "";
			if (remote) {
				const ref = await app.spawnRemote(
					remote, params.name || "", params.task);
				if (!ref) {
					throw new Error(`no peer agent on ${remote}`);
				}
				return {
					content: [{
						type: "text",
						text: `spawned teammate ${ref.id} on ${remote}; ` +
							`call team_wait with id "${ref.id}" to block for ` +
							`its report.`,
					}],
					details: ref,
				};
			}
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
						`"${ref.session}"; wait with team_wait id ` +
						`"${ref.id}", or continue and it reports as a ` +
						`pi-teams message.`,
				}],
				details: ref,
			};
		},
	});

	// -- agent-facing teammate wait --------------------------------------
	// Blocks until the teammate reports, so the parent needs neither to
	// poll nor to end its turn. The wait publishes the agent as idle (a
	// waiting agent is not working), then restores its busy state.
	pi.registerTool({
		name: "team_wait",
		label: "wait for teammates",
		description:
			"Wait for one or more teammates to report, when you want to " +
			"block. Pass the id or ids returned by team_spawn; returns each " +
			"report as the tool result once every teammate has reported or " +
			"the wait bound elapses. While blocked the agent is idle. If you " +
			"have other work, skip this: the teammate still reports as a " +
			"pi-teams message.",
		promptSnippet: "Wait for teammate reports when you choose to",
		promptGuidelines: [
			"Use team_wait only when you want to block for teammate " +
				"results: pass the id or ids from team_spawn, and one call can " +
				"wait on several. If you have other work, continue instead; " +
				"every teammate reports as a pi-teams message. A timed-out " +
				"teammate still reports later.",
		],
		parameters: Type.Object({
			id: Type.Optional(Type.String({
				description: "One teammate id returned by team_spawn",
			})),
			ids: Type.Optional(Type.Array(Type.String(), {
				description: "Several teammate ids returned by team_spawn",
			})),
			wait: Type.Optional(Type.Number({
				description: "Seconds to wait (default PI_TEAMS_WAIT or 300)",
			})),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const targetIds = (params.ids && params.ids.length > 0)
				? params.ids
				: params.id ? [params.id] : [];
			if (targetIds.length === 0) {
				throw new Error("team_wait needs at least one teammate id");
			}
			const bound = waitSeconds(params.wait);
			// A waiting agent is idle, not working: publish that for the
			// block, then restore the turn's busy state. The broker keeps a
			// waiting fork exempt from idle GC.
			app.setState("waiting");
			try {
				const results = await app.waitForResults(
					targetIds, bound * 1000, signal);
				const parts: string[] = [];
				const details: unknown[] = [];
				for (const [id, message] of results) {
					if (!message) {
						parts.push(`no result from ${id} within ${bound}s; ` +
							`it is still running and will report as a message.`);
						details.push({ id, message: null });
						continue;
					}
					logTeamMessage(pi, "received", message);
					const payload = typeof message.payload === "string"
						? message.payload
						: JSON.stringify(message.payload);
					parts.push(`pi-teams ${message.kind} from ` +
						`${message.from}:\n${payload}`);
					details.push(message);
				}
				return {
					content: [{ type: "text", text: parts.join("\n\n") }],
					details,
				};
			} finally {
				app.setBusy(true);
			}
		},
	});

	// -- cross-host peers ------------------------------------------------
	// One call links another host's broker over an existing SSH session:
	// the extension reads the peer endpoint read-only, opens a loopback
	// ssh -L tunnel, and tells the local broker to federate.
	pi.registerTool({
		name: "team_peer",
		label: "link a peer host",
		description:
			"Connect another host's pi-teams broker over an existing SSH " +
			"session. add fetches the peer's loopback endpoint read-only, " +
			"opens a loopback-bound ssh -L tunnel, and links the two " +
			"brokers so agents can message across hosts; remove drops the " +
			"link. The peer host must already run pi-teams.",
		promptSnippet: "Link another host's pi-teams broker over SSH",
		promptGuidelines: [
			"Call team_peer add <ssh-host> once to enable cross-host " +
				"teammates. After that, team_spawn with host=<label> spawns " +
				"on that host and messages route both ways.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("add"),
				Type.Literal("remove"),
			]),
			host: Type.String({
				description: "SSH host to reach (also the default peer label)",
			}),
			label: Type.Optional(Type.String({
				description: "Peer label override",
			})),
		}),
		async execute(_toolCallId, params) {
			if (params.action === "add") {
				const peer = await app.peerAdd(
					params.host, params.label || "");
				return {
					content: [{
						type: "text",
						text: `linked peer ${peer} over ssh ${params.host}; ` +
							`use team_spawn host=${peer} to spawn there.`,
					}],
					details: { peer },
				};
			}
			await app.peerRemove(params.host);
			return {
				content: [{
					type: "text",
					text: `unlinked peer ${params.host}`,
				}],
				details: undefined,
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
