/**
 * TeamAgent: the pi session's live identity and every team operation. It
 * owns the hold connection, the launched teammates, peer bridges, the
 * spawn/attach request bookkeeping, the waiter inbox, and lifecycle
 * cleanup. Identity is read from the environment once, then owned here.
 */

import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import {
	piInvocation,
	stateRoot,
	teamBin,
	teamdBin,
} from "./paths.ts";
import type { ProcessHost, SpawnedProcess } from "./process-runner.ts";
import {
	resolvePython,
	WindowlessPython,
	type InterpreterResolver,
} from "./interpreter.ts";
import {
	SshPeerBridge,
	type BridgeFactory,
	type PeerBridge,
	type PeerEndpoint,
} from "./peer.ts";
import { AgentDirectory, type AgentInfo } from "./directory.ts";
import {
	LocalSpawnBackend,
	PeerSpawnBackend,
	SpawnRouter,
	type SpawnOptions,
	type TeammateRef,
} from "./spawn.ts";
import { ResultInbox } from "./inbox.ts";
import {
	DEFAULT_WAIT_SECONDS,
	WAIT_POLL_MS,
	type DeliverFn,
	type TeamMessage,
} from "./protocol.ts";

export class TeamAgent {
	private readonly runner: ProcessHost;
	private readonly deliver: DeliverFn;
	private readonly makeBridge: BridgeFactory;
	private readonly python: string;
	private readonly windowless: InterpreterResolver;
	id: string = "";
	private role: string;
	private parent = "";
	private attachedName = "";
	private teamOwner = false;
	private closed = false;
	private cwd = "";
	private announced = false;
	private holdProc: SpawnedProcess | null = null;
	private readonly teammates = new Set<SpawnedProcess>();
	private readonly bridges = new Map<string, PeerBridge>();
	private readonly openingBridges = new Set<PeerBridge>();
	private readonly peersFile: string;
	private readonly directory: AgentDirectory;
	private readonly spawnRouter: SpawnRouter;
	private readonly pendingSpawns =
		new Map<string, (ref: TeammateRef | null) => void>();
	private readonly pendingAttaches =
		new Map<string, (ref: TeammateRef | null) => void>();
	private readonly inbox = new ResultInbox();
	readonly host: string;
	private sessionFile = "";
	private sessionDir = "";

	constructor(
		runner: ProcessHost,
		deliver: DeliverFn = () => {},
		bridgeFactory?: BridgeFactory,
		windowlessFactory: (python: string) => InterpreterResolver =
			(python) => new WindowlessPython(python),
	) {
		this.runner = runner;
		this.deliver = deliver;
		this.makeBridge = bridgeFactory
			?? ((sshTarget, label) =>
				new SshPeerBridge(sshTarget, label, runner));
		this.python = resolvePython();
		this.windowless = windowlessFactory(this.python);
		this.peersFile = join(stateRoot, "peers-ssh.json");
		this.host = process.env.PI_TEAMS_HOST || hostname().split(".")[0];
		this.id = process.env.TEAM_ID || this.makeMainId();
		this.role = process.env.TEAM_ID ? "fork" : "main";
		this.parent = process.env.TEAM_PARENT_ID || "";
		this.directory = new AgentDirectory(() => this.snapshot(), this.host);
		this.spawnRouter = new SpawnRouter(
			this.host,
			new LocalSpawnBackend((name, task, options) =>
				this.spawnTask(name, task, options)),
			(peerHost) => new PeerSpawnBackend(
				peerHost,
				this.directory,
				(to, kind, text) => this.send(to, kind, text),
				(requestId, ms) => this.waitForSpawn(requestId, ms)),
		);
	}

	/** A fresh main-agent id. The host label makes the id globally
	 *  unique so peers can route by its prefix. */
	private makeMainId(): string {
		return `${this.host}:pi-${process.pid}-` +
			Math.random().toString(16).slice(2, 10);
	}

	private launch(
		file: string,
		args: string[],
		options: Record<string, unknown>,
	): SpawnedProcess | null {
		return this.guard(this.runner.spawnHidden(file, args, options));
	}

	private launchDetached(
		file: string,
		args: string[],
		options: Record<string, unknown>,
	): SpawnedProcess | null {
		return this.guard(this.runner.spawnDetached(file, args, options));
	}

	private launchPersistent(
		file: string,
		args: string[],
		options: Record<string, unknown>,
	): SpawnedProcess | null {
		return this.guard(this.runner.spawnPersistent(file, args, options));
	}

	private guard(child: SpawnedProcess | null): SpawnedProcess | null {
		child?.on("error", () => {
			// A failed broker/hold/pi start must not crash the session;
			// the next /team call retries.
		});
		return child;
	}

	ensureBroker(): void {
		// The broker owns its own restart policy: once its on-disk source
		// changes it exits after an idle window, and the next start adopts
		// the new code. The extension only starts one when none is
		// published, so a reload never kills live work.
		if (existsSync(join(stateRoot, "endpoint"))) return;
		this.startBroker();
	}

	/** Launch the detached broker; the broker lock admits only one. */
	private startBroker(): void {
		// The broker never exits, so it must survive the session. On
		// Windows a windowless interpreter keeps that persistence from
		// flashing a console.
		const interpreter = this.windowless.resolve();
		const child = this.launchPersistent(
			interpreter,
			[teamdBin, "--root", stateRoot, "start"],
			{ stdio: "ignore" },
		);
		child?.unref();
	}

	hold(cwd?: string): void {
		if (cwd) this.cwd = cwd;
		this.stopHold();
		const name = this.attachedName || process.env.TEAM_NAME
			|| `pi@${this.cwd || process.cwd()}`;
		const busyFile = this.busyFile();
		const env = this.holdEnv(name, this.role, this.parent, busyFile);
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
		if (message.kind === "attach-ack" || message.kind === "attach-error") {
			this.resolveAttach(message);
			return;
		}
		if (message.kind === "attach") {
			this.handleAttachRequest(message);
			return;
		}
		// A result first goes to an active team_wait, which consumes it as
		// the tool result; when none is waiting it is buffered and still
		// delivered as an ordinary message, so no report is ever lost.
		if (message.kind === "result" && message.to === this.id) {
			if (this.inbox.deliver(message)) return;
		}
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
		const result = await this.runner.run(
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
		// The peer's spawn handler replies to the message's `from`, and a
		// spawned fork is parented to it, so an unregistered sender would
		// strand both. Hand this agent's id to the transient client.
		const result = await this.runner.run(
			this.python,
			[teamBin, "--root", stateRoot, "send",
				"--id", this.id, to, kind, text],
			{ timeout: 3000 },
		);
		return String(result.stdout).trim();
	}

	/** Whether this session is a team member: spawned as a teammate (role
	 *  fork), attached to one, or the owner of spawned or attached
	 *  teammates (spawning implies attachment). Messaging and waiting are
	 *  member-only operations. */
	async isTeammate(): Promise<boolean> {
		if (this.role === "fork" || this.teamOwner) return true;
		return this.ownsTeammates();
	}

	/** Whether another live agent is parented to this session. Deriving
	 *  it from the registry keeps the fact across a reload instead of
	 *  relying on in-memory state alone. */
	private async ownsTeammates(): Promise<boolean> {
		const agents = await this.snapshot();
		return agents.some((a) => a.parent === this.id);
	}

	/** Gate for member-only agent operations; throws with the fix when
	 *  this session is not a team member. Control traffic (acks, notices)
	 *  uses the raw send path and is not gated. */
	async requireTeammate(action: string): Promise<void> {
		if (await this.isTeammate()) return;
		throw new Error(
			`${action} requires being a team member; attach first with ` +
			`team_attach or /team attach <parent>`);
	}

	/** Whether this session is itself a teammate of another agent (has a
	 *  parent), as opposed to a team root. */
	hasParent(): boolean {
		return this.parent !== "";
	}

	/** The id of the team root that owns `agentId`, walking the parent
	 *  chain in the registry. A missing or cyclic chain resolves to the
	 *  last known id rather than throwing. */
	async teamRootOf(agentId: string): Promise<string> {
		const agents = await this.snapshot();
		const byId = new Map(agents.map((a) => [a.id, a]));
		let current = agentId;
		const seen = new Set<string>();
		while (current && !seen.has(current)) {
			seen.add(current);
			const entry = byId.get(current);
			if (!entry || !entry.parent) return current;
			current = entry.parent;
		}
		return agentId;
	}

	/** Whether two agents share one team root. */
	async sameTeam(a: string, b: string): Promise<boolean> {
		const rootA = await this.teamRootOf(a);
		const rootB = await this.teamRootOf(b);
		return rootA === rootB;
	}

	/** A teammate may only reach agents in its own team; to reach an
	 *  outsider it must ask its parent to attach that agent. A root (no
	 *  parent) is unrestricted. */
	async requireSameTeam(target: string): Promise<void> {
		if (!this.hasParent()) return;
		if (await this.sameTeam(this.parent, target)) return;
		throw new Error(
			`${target} is outside your team; ask your parent ${this.parent} ` +
			`to attach it (team_attach) before messaging it.`);
	}

	/** A team has one parent per agent: refuse to attach a target that is
	 *  already a teammate. A parent agent with no parent of its own may
	 *  still be attached, becoming a teammate as well. */
	private async requireAttachable(target: string): Promise<void> {
		const agents = await this.snapshot();
		const entry = agents.find((a) => a.id === target);
		if (entry && entry.parent) {
			throw new Error(
				`${target} is already a teammate of ${entry.parent}; ` +
				`an agent belongs to one team.`);
		}
	}

	/** Spawns a teammate on `host` (empty or this host = local) behind a
	 *  single interface; the router selects the local or peer backend. */
	async spawn(
		host: string,
		name: string,
		task: string,
		options: SpawnOptions = {},
	): Promise<TeammateRef | null> {
		const ref = await this.spawnRouter.spawn(host, name, task, options);
		// Spawning a teammate makes this session a team member too, so it
		// can message and wait without a separate attach.
		if (ref) this.teamOwner = true;
		return ref;
	}

	private waitForSpawn(
		requestId: string,
		timeoutMs: number,
	): Promise<TeammateRef | null> {
		return new Promise((resolve) => {
			if (this.closed) {
				resolve(null);
				return;
			}
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

	/** Re-registers this running session as a teammate of `parent`. The
	 *  broker then treats it as a fork, so it can be waited on and is
	 *  GC'd with the parent. The session file is left intact (no spawn
	 *  marker), so it stays in `/resume` after the fork is reaped. */
	async attachTo(parent: string, name?: string): Promise<TeammateRef> {
		if (!parent) throw new Error("attach needs a parent agent id");
		if (this.hasParent()) {
			throw new Error(
				"already a teammate; an agent belongs to one team, " +
				"detach first to change parents");
		}
		const previousBusy = this.busyFile();
		const forkId = this.makeForkId();
		const session = name || this.attachedName || this.id;
		this.id = forkId;
		this.role = "fork";
		this.parent = parent;
		this.attachedName = session;
		try {
			unlinkSync(previousBusy);
		} catch {
			// absent, or the broker's orphan sweep reaps it
		}
		this.hold(this.cwd);
		this.announced = false;
		await this.send(parent, "notice",
			`attached ${forkId} (${session})`);
		return { id: forkId, session };
	}

	/** Returns an attached teammate to a plain main agent so it is no
	 *  longer reaped with a parent. */
	detach(): string {
		const previousBusy = this.busyFile();
		this.id = this.makeMainId();
		this.role = "main";
		this.parent = "";
		this.attachedName = "";
		try {
			unlinkSync(previousBusy);
		} catch {
			// absent, or already swept
		}
		this.hold(this.cwd);
		this.announced = false;
		return this.id;
	}

	/** Asks a live agent to re-register itself as this agent's teammate.
	 *  The target may be local or on a linked peer; the broker routes the
	 *  same control message either way, and the target owns the identity
	 *  change and reports its new fork id. */
	async attach(
		target: string,
		name?: string,
	): Promise<TeammateRef | null> {
		await this.requireAttachable(target);
		if (this.closed) return null;
		const requestId =
			`attach-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
		const pending = this.waitForAttach(requestId, 15000);
		await this.send(target, "attach", JSON.stringify({ requestId, name }));
		return pending;
	}

	private waitForAttach(
		requestId: string,
		timeoutMs: number,
	): Promise<TeammateRef | null> {
		return new Promise((resolve) => {
			if (this.closed) {
				resolve(null);
				return;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (ref: TeammateRef | null): void => {
				if (timer) clearTimeout(timer);
				this.pendingAttaches.delete(requestId);
				resolve(ref);
			};
			this.pendingAttaches.set(requestId, settle);
			timer = setTimeout(() => settle(null), timeoutMs);
		});
	}

	private resolveAttach(message: TeamMessage): void {
		const payload = (message.payload ?? {}) as {
			requestId?: string; id?: string; session?: string;
		};
		if (!payload.requestId) return;
		const settle = this.pendingAttaches.get(payload.requestId);
		if (!settle) return;
		this.pendingAttaches.delete(payload.requestId);
		if (message.kind === "attach-ack" && payload.id) {
			settle({ id: payload.id, session: payload.session || payload.id });
		} else {
			settle(null);
		}
	}

	/** Another agent asked this running session to become its teammate:
	 *  this session owns the identity change. */
	private handleAttachRequest(message: TeamMessage): void {
		const payload = (message.payload ?? {}) as {
			name?: string; requestId?: string;
		};
		if (this.hasParent()) {
			void this.send(message.from, "attach-error", JSON.stringify({
				requestId: payload.requestId, why: "already-a-teammate",
			}));
			return;
		}
		void this.attachTo(message.from, payload.name)
			.then((ref) => {
				this.deliver({
					from: message.from, to: ref.id, kind: "text",
					payload: `You are now a teammate of ${message.from}. ` +
						`Report results by running: ${this.reportCommand()}`,
				});
				return this.send(message.from, "attach-ack",
					JSON.stringify({
						requestId: payload.requestId, id: ref.id,
						session: ref.session,
					}));
			})
			.catch(() => this.send(message.from, "attach-error",
				JSON.stringify({ requestId: payload.requestId })));
	}

	async terminate(agentId: string): Promise<void> {
		await this.runner.run(
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
		// The marker phrase here is the broker's teammate-session stamp; keep
		// it in sync with TEAMMATE_MARKER in src/teamd.py.
		// Call the interpreter on the absolute client path instead of a
		// `team` name on PATH: a shebang script is not executable on
		// Windows, and binDir may not be on PATH. The teammate runs this
		// through its shell tool, where the $TEAM_* variables expand.
		const send = this.reportCommand();
		return (
			`You are "${session}", a teammate spawned by a parent pi session ` +
			`to do one task. Do the task, then report the outcome to your ` +
			`parent by running this command:\n  ${send}\n` +
			`Do not write memory. Task:\n${task}`
		);
	}

	/** The teammate report-back command, run through the interpreter on
	 *  the absolute client path (a shebang script is not executable on
	 *  Windows, and binDir may not be on PATH). Shared by the spawn
	 *  prompt and an attached teammate. */
	private reportCommand(): string {
		return `"${this.python}" "${teamBin}" --root "$TEAM_ROOT" ` +
			`send "$TEAM_PARENT_ID" result "<report>"`;
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
		const child = this.launchDetached(
			invocation.command,
			[...invocation.args, ...args],
			{ env, stdio: ["pipe", "ignore", "ignore"] },
		);
		if (!child) return;
		this.teammates.add(child);
		child.on("exit", () => this.teammates.delete(child));
		child.on("error", () => this.teammates.delete(child));
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

	private closeBridges(): void {
		// A bridge still opening is not yet in `bridges`; close it too so a
		// deregister during connect cannot orphan its ssh tunnel.
		for (const bridge of this.openingBridges) bridge.close();
		this.openingBridges.clear();
		for (const bridge of this.bridges.values()) bridge.close();
		this.bridges.clear();
	}

	/** Links a peer host's broker. The bridge owns every transport
	 *  detail (SSH or otherwise); this method only registers the loopback
	 *  endpoint with the local broker and keeps the bridge for reaping.
	 *  Returns the peer label. */
	async peerAdd(sshTarget: string, label: string): Promise<string> {
		const bridge = this.makeBridge(sshTarget, label);
		this.openingBridges.add(bridge);
		let endpoint: PeerEndpoint;
		try {
			endpoint = await bridge.connect();
			if (bridge.peerHost && bridge.peerHost === this.host) {
				throw new Error(
					`peer ${sshTarget} reports host label "${bridge.peerHost}", ` +
					"which collides with this host; set PI_TEAMS_HOST to a " +
					"unique label on one host");
			}
			await this.linkPeer(bridge.name, endpoint);
		} catch (err) {
			this.openingBridges.delete(bridge);
			bridge.close();
			throw err;
		}
		this.openingBridges.delete(bridge);
		this.bridges.set(bridge.name, bridge);
		this.rememberPeer(bridge.name, sshTarget);
		// A tunnel that dies on its own must not leave a peer pointing
		// at a dead loopback port: drop it and prune the broker's entry.
		bridge.onExit(() => {
			if (this.bridges.get(bridge.name) === bridge) {
				this.bridges.delete(bridge.name);
			}
			void this.unlinkPeer(bridge.name);
		});
		return bridge.name;
	}

	async peerRemove(host: string): Promise<void> {
		const bridge = this.bridges.get(host);
		this.bridges.delete(host);
		this.forgetPeer(host);
		bridge?.close();
		await this.unlinkPeer(host);
	}

	/** The durable SSH-peer map, label -> ssh target. The broker's
	 *  persisted endpoint is a loopback tunnel port that exists only while
	 *  this process's ssh tunnel lives, so the extension owns the target
	 *  and rebuilds the tunnel on the next session. */
	private readPeerTargets(): Record<string, string> {
		try {
			const parsed = JSON.parse(readFileSync(this.peersFile, "utf-8"));
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}

	private writePeerTargets(targets: Record<string, string>): void {
		const tmp = `${this.peersFile}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(targets, null, 2) + "\n");
			renameSync(tmp, this.peersFile);
		} catch {
			try {
				unlinkSync(tmp);
			} catch {
				// the temp file was never written
			}
		}
	}

	/** Labels of host brokers linked via team_peer (durable map). */
	linkedPeers(): string[] {
		return Object.keys(this.readPeerTargets()).sort();
	}

	/** Resolves a peer name to the ssh target that reaches it: a
	 *  remembered label maps to its stored target, anything else is used
	 *  as given. This lets team_peer add reuse an already-linked peer by
	 *  the label its agents are addressed by. */
	peerTarget(name: string): string {
		return this.readPeerTargets()[name] ?? name;
	}

	private rememberPeer(label: string, sshTarget: string): void {
		const targets = this.readPeerTargets();
		targets[label] = sshTarget;
		this.writePeerTargets(targets);
	}

	private forgetPeer(label: string): void {
		const targets = this.readPeerTargets();
		if (label in targets) {
			delete targets[label];
			this.writePeerTargets(targets);
		}
	}

	/** Rebuilds every remembered peer link. An ssh tunnel is owned by this
	 *  process, so a reload leaves the broker pointing at a dead loopback
	 *  port; re-resolving the peer endpoint restores it. A failure stays
	 *  in the map so the next session retries. */
	async restorePeers(): Promise<void> {
		for (const [label, sshTarget] of Object.entries(this.readPeerTargets())) {
			if (this.bridges.has(label)) continue;
			try {
				await this.peerAdd(sshTarget, label);
			} catch {
				// unreachable now; keep the target for the next session
			}
		}
	}

	private async linkPeer(
		host: string,
		endpoint: PeerEndpoint,
	): Promise<void> {
		const result = await this.runner.run(this.python, [
			teamBin, "--root", stateRoot, "peer", "add", host,
			`${endpoint.host}:${endpoint.port}:${endpoint.token}`,
		]);
		if (result.code !== 0) {
			throw new Error(
				`broker rejected peer ${host}: ${result.stderr.trim()}`);
		}
	}

	private async unlinkPeer(host: string): Promise<void> {
		await this.runner.run(this.python, [
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

	/** Actively waits for one result per listed teammate under the call's
	 *  stop conditions: a result arrives, the bound elapses, the run aborts
	 *  (Escape), a user message is queued, or the session deregisters. The
	 *  poll awaits between checks so the TUI stays responsive and the wait
	 *  stays steerable. Returns one entry per id, null when that teammate
	 *  did not report before the wait ended. */
	async waitForResults(
		agentIds: string[],
		timeoutMs: number,
		signal: AbortSignal | undefined,
		shouldYield: () => boolean,
	): Promise<Array<TeamMessage | null>> {
		const results = new Map<string, TeamMessage>();
		const pending: string[] = [];
		for (const id of agentIds) {
			const buffered = this.inbox.take(id);
			if (buffered) results.set(id, buffered);
			else pending.push(id);
		}
		const canWait = pending.length > 0 && !this.closed
			&& !signal?.aborted && !shouldYield();
		if (canWait) {
			await new Promise<void>((resolve) => {
				const unwatchers: Array<() => void> = [];
				let timer: ReturnType<typeof setTimeout> | undefined;
				let poll: ReturnType<typeof setInterval> | undefined;
				let settled = false;
				const finish = (): void => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					if (poll) clearInterval(poll);
					signal?.removeEventListener("abort", onAbort);
					for (const unwatch of unwatchers) unwatch();
					resolve();
				};
				const onAbort = (): void => finish();
				for (const id of pending) {
					const unwatch = this.inbox.watch(id, (message) => {
						if (!message) {
							finish();
							return;
						}
						results.set(id, message);
						if (results.size === agentIds.length) finish();
					});
					unwatchers.push(unwatch);
				}
				poll = setInterval(() => {
					if (this.closed || signal?.aborted || shouldYield()) {
						finish();
					}
				}, WAIT_POLL_MS);
				if (signal) {
					if (signal.aborted) finish();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				const effective = timeoutMs > 0
					? timeoutMs : DEFAULT_WAIT_SECONDS * 1000;
				timer = setTimeout(finish, effective);
			});
		}
		return agentIds.map((id) => results.get(id) ?? null);
	}

	private cancelWaits(): void {
		// Deregister is terminal: a race that registers a pending request
		// after this point must resolve at once instead of leaking a timer.
		this.closed = true;
		for (const settle of [...this.pendingSpawns.values()]) settle(null);
		this.pendingSpawns.clear();
		for (const settle of [...this.pendingAttaches.values()]) settle(null);
		this.pendingAttaches.clear();
		this.inbox.cancelAll();
		this.spawnRouter.clear();
	}

	deregister(): void {
		this.cancelWaits();
		this.stopHold();
		this.stopTeammates();
		this.closeBridges();
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
			`Spawn a teammate: team_spawn (task, name). Messaging and ` +
			`waiting require a team member; attach with team_attach or ` +
			`/team attach <parent>. A teammate may only message its own ` +
			`team, so ask your parent to attach an outsider first, and an ` +
			`agent belongs to one team. Peer hosts: team_peer add ` +
			`<ssh-host>, then team_spawn host=<label>. list: /team ls.`;
		return { customType: "pi-teams", content, display: false };
	}
}
