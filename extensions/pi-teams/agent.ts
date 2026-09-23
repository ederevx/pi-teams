/**
 * TeamAgent: the pi session's live identity and every team operation. It
 * owns the hold connection, the launched teammates, the spawn/attach
 * spawn/attach request bookkeeping, the waiter inbox, and lifecycle
 * cleanup. Identity is read from the environment once, then owned here.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { connect as netConnect } from "node:net";
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
import { BrokerOps, type PeerInfo } from "./broker-ops.ts";
import { AgentDirectory, type AgentInfo } from "./directory.ts";
import {
	SpawnService,
	type SpawnOptions,
	type TeammateRef,
} from "./spawn.ts";
import { PendingRequests } from "./pending.ts";
import { ResultInbox } from "./inbox.ts";
import { TeammateRole } from "./roles.ts";
import {
	DEFAULT_STALL_SECONDS,
	DEFAULT_WAIT_SECONDS,
	STEER_NUDGE_TEXT,
	WAIT_POLL_MS,
	mintSendToken,
	requestId,
	type DeliverFn,
	type TeamMessage,
} from "./protocol.ts";

export class TeamAgent {
	private readonly runner: ProcessHost;
	private readonly deliver: DeliverFn;
	private readonly python: string;
	private readonly windowless: InterpreterResolver;
	id: string = "";
	private role: string;
	/** This session's send credential for gated broker ops (see
	 *  send_gate.py). The hold registers with it; transient sends and
	 *  spawned teammates' environments carry it. */
	private sendToken: string;
	private parent = "";
	private attachedName = "";
	// The process env the attach path overwrote, restored on detach.
	private savedEnv: Record<string, string | undefined> | undefined;
	// Whether the current hold was started by an attach, so a relaunch
	// keeps the attached identity (and its GC exemption) after a death.
	private attachedHold = false;
	private teamOwner = false;
	private closed = false;
	private cwd = "";
	private announced = false;
	private holdProc: SpawnedProcess | null = null;
	private holdStartedAt = 0;
	private holdRestarts = 0;
	private readonly teammates = new Set<SpawnedProcess>();
	private readonly directory: AgentDirectory;
	private readonly brokerOps: BrokerOps;
	private readonly pending = new PendingRequests();
	private readonly spawns: SpawnService;
	private readonly inbox = new ResultInbox();
	private readonly teammateRole = new TeammateRole();
	// Notified on every contact from a teammate the active wait is
	// blocked on, so its stall watchdog counts any traffic, not only
	// results, as a sign of life. Owned by the agent; the wait
	// registers and always removes its hook.
	private activityHook: ((from: string) => void) | null = null;
	readonly host: string;
	private sessionFile = "";
	private sessionDir = "";
	/** Seen envelope ids, oldest first; a mailbox redelivery after a
	 *  crash between write and drop arrives twice, and the second copy
	 *  must not surface. */
	private seenMessageIds = new Set<string>();

	constructor(
		runner: ProcessHost,
		deliver: DeliverFn = () => {},
		windowlessFactory: (python: string) => InterpreterResolver =
			(python) => new WindowlessPython(python),
	) {
		this.runner = runner;
		this.deliver = deliver;
		this.python = resolvePython();
		this.windowless = windowlessFactory(this.python);
		this.host = process.env.PI_TEAMS_HOST || hostname().split(".")[0];
		this.id = process.env.TEAM_ID || this.makeMainId();
		this.role = process.env.TEAM_ID ? "fork" : "main";
		this.parent = process.env.TEAM_PARENT_ID || "";
		// One send token per session: the hold registers with it, the
		// transient sends present it, and spawned teammates inherit a
		// fresh one through their environment (see teammateEnv).
		this.sendToken = process.env.TEAM_SEND_TOKEN || mintSendToken();
		this.directory = new AgentDirectory(() => this.snapshot(), this.host);
		this.brokerOps = new BrokerOps(runner, this.python);
		this.brokerOps.sendToken = this.sendToken;
		this.spawns = new SpawnService(
			this.host, this.directory, this.brokerOps, this.pending,
			(name, task, options) => this.spawnTask(name, task, options));
	}

	/** A fresh agent id of one kind. The host label makes the id
	 *  globally unique so peers can route by its prefix; the kind is
	 *  the id's role in the registry (`pi` main, `fork` teammate). */
	private makeId(kind: string): string {
		return `${this.host}:${kind}-${process.pid}-` +
			Math.random().toString(16).slice(2, 10);
	}

	private makeMainId(): string {
		return this.makeId("pi");
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
			// the next agent action retries.
		});
		return child;
	}

	ensureBroker(): void {
		// The broker owns its own restart policy: once its on-disk source
		// changes it exits after an idle window, and the next start adopts
		// the new code. The extension only starts one when none is
		// published, so a reload never kills live work.
		const endpointPath = join(stateRoot, "endpoint");
		if (!existsSync(endpointPath)) {
			this.startBroker();
			return;
		}
		// The endpoint file's existence alone never proved a broker
		// lives behind it: a dead broker left a stale endpoint that
		// blocked every hold. Probe the published port once; only a
		// refused connection proves the endpoint stale, a timeout
		// stays conservative.
		void this.verifyEndpoint(endpointPath);
	}

	/** Probes the published broker endpoint; unlinks it and starts a
	 *  replacement only when nothing is listening. */
	private async verifyEndpoint(endpointPath: string): Promise<void> {
		let endpoint: { host?: string; port?: number };
		try {
			endpoint = JSON.parse(readFileSync(endpointPath, "utf8"));
		} catch {
			return;
		}
		const port = endpoint?.port;
		if (!port) return;
		await new Promise<void>((resolve) => {
			const socket = netConnect(port, endpoint.host || "127.0.0.1");
			const settle = (stale: boolean) => {
				socket.removeAllListeners();
				socket.destroy();
				if (stale) {
					try {
						unlinkSync(endpointPath);
					} catch {
						// Another session already swept it.
					}
					this.startBroker();
				}
				resolve();
			};
			socket.setTimeout(1000);
			socket.once("error", (err: NodeJS.ErrnoException) =>
				settle(err?.code === "ECONNREFUSED"));
			socket.once("timeout", () => settle(false));
			socket.once("connect", () => settle(false));
		});
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

	hold(cwd?: string, attached = false): void {
		if (cwd) this.cwd = cwd;
		this.attachedHold = attached;
		this.stopHold();
		const name = this.attachedName || process.env.TEAM_NAME
			|| `pi@${this.cwd || process.cwd()}`;
		const busyFile = this.busyFile();
		const env = this.holdEnv(name, this.role, this.parent, busyFile,
			attached);
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
		this.holdStartedAt = Date.now();
		if (proc) {
			proc.on("exit", () => this.holdDied(proc));
		}
		if (proc?.stdout) this.forwardMessages(proc.stdout);
	}

	/** A hold client that dies on its own (a broker restart or the
	 *  idle exit after a source change) leaves the session deaf until
	 *  the next session event: relaunch it with a bounded backoff. An
	 *  intentional stop clears holdProc before killing, so only an
	 *  unexpected death reaches here. */
	private holdDied(proc: SpawnedProcess): void {
		if (this.holdProc !== proc) return;
		this.holdProc = null;
		if (this.closed) return;
		// A hold that ran a while resets the backoff: this death is a
		// new failure, not a repeat of the previous one.
		if (Date.now() - this.holdStartedAt > 60000) this.holdRestarts = 0;
		this.holdRestarts += 1;
		if (this.holdRestarts > 5) return;
		const delay = Math.min(30000, 1000 * 2 ** this.holdRestarts);
		const timer = setTimeout(() => {
			if (this.closed || this.holdProc) return;
			this.ensureBroker();
			this.hold(this.cwd, this.attachedHold);
		}, delay);
		if (typeof timer === "object" && timer && "unref" in timer) {
			timer.unref();
		}
	}

	/** The hold's environment: this agent's identity plus the busy file
	 *  the heartbeat reads for its run-state. */
	private holdEnv(
		name: string,
		role: string,
		parent: string,
		busyFile: string,
		attached: boolean,
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
			TEAM_ATTACHED: attached ? "1" : "",
			TEAM_SEND_TOKEN: this.sendToken,
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
		// JSON.parse also yields scalars ("null", "123"); touching kind
		// on those would throw inside the stdout data handler.
		if (!message || typeof message !== "object") return;
		if (typeof message.id === "string" && message.id) {
			if (this.seenMessageIds.has(message.id)) return;
			this.seenMessageIds.add(message.id);
			if (this.seenMessageIds.size > 128) {
				const oldest = this.seenMessageIds.values().next().value;
				if (oldest !== undefined) this.seenMessageIds.delete(oldest);
			}
		}
		if (message.kind === "spawn-ack" || message.kind === "spawn-error") {
			this.pending.settle(message, "spawn-ack");
			return;
		}
		if (message.kind === "spawn") {
			this.handleSpawnRequest(message);
			return;
		}
		if (message.kind === "attach-ack" || message.kind === "attach-error") {
			this.pending.settle(message, "attach-ack");
			return;
		}
		if (message.kind === "finish?") {
			// The broker asks whether this agent is done before reaping
			// it as idle. The state was published idle, so answer done
			// through the CLI; a still-working agent would have
			// answered busy from its heartbeat instead of surfacing
			// here.
			void this.runner.run(
				this.python,
				[teamBin, "--root", stateRoot, "finish", "--done"],
				{ timeout: 5000 },
			);
			return;
		}
		if (message.kind === "attach") {
			// The handler reports every failure back as attach-error; the
			// catch only keeps an unexpected rejection from surfacing as
			// an unhandled one.
			this.handleAttachRequest(message).catch(() => {});
			return;
		}
		// Any inbound contact counts as the sender being alive for the
		// active wait's stall watchdog; results are handled below.
		if (this.activityHook && message.from) this.activityHook(message.from);
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
		return this.brokerOps.snapshot();
	}

	async send(to: string, kind: string, text: string): Promise<string> {
		// The peer's spawn handler replies to the message's `from`, and a
		// spawned fork is parented to it, so an unregistered sender would
		// strand both. Hand this agent's id to the transient client.
		return this.brokerOps.send(to, kind, text, this.id, this.sendToken);
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
			`${action} requires being a team member; a parent attaches you ` +
			`with team_attach`);
	}

	/** Whether this session is itself a teammate of another agent (has a
	 *  parent), as opposed to a team root. */
	hasParent(): boolean {
		return this.parent !== "";
	}

	/** The attach env for an attached session: the same identity keys a
	 *  spawned fork receives at launch, applied to this process so shell
	 *  tools inherit them. The previous values are kept for detach. */
	private applyAttachEnv(
		forkId: string,
		session: string,
	): void {
		this.savedEnv = {
			TEAM_ID: process.env.TEAM_ID,
			TEAM_NAME: process.env.TEAM_NAME,
			TEAM_ROLE: process.env.TEAM_ROLE,
			TEAM_PARENT_ID: process.env.TEAM_PARENT_ID,
			TEAM_ROOT: process.env.TEAM_ROOT,
		};
		Object.assign(process.env, {
			TEAM_ID: forkId,
			TEAM_NAME: session,
			TEAM_ROLE: "fork",
			TEAM_PARENT_ID: this.parent,
			TEAM_ROOT: stateRoot,
			// An attached fork keeps its own token: the hold re-registers
			// under the fork id with it, and the report-back command's
			// $TEAM_SEND_TOKEN expands to it.
			TEAM_SEND_TOKEN: this.sendToken,
		});
	}

	/** Restores the env that applyAttachEnv overwrote; absent keys are
	 *  removed again so a detached session matches its launch state. */
	private restoreMainEnv(): void {
		if (!this.savedEnv) return;
		for (const [key, value] of Object.entries(this.savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		this.savedEnv = undefined;
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
	 *  single interface; the service addresses the local process or the
	 *  peer host's main agent. */
	async spawn(
		host: string,
		name: string,
		task: string,
		options: SpawnOptions = {},
	): Promise<TeammateRef | null> {
		const ref = await this.spawns.spawn(host, name, task, options);
		// Spawning a teammate makes this session a team member too, so it
		// can message and wait without a separate attach.
		if (ref) this.teamOwner = true;
		return ref;
	}

	/** A peer host asked this agent to spawn a teammate: this host owns
	 *  the process and session and reports the new id back. */
	private handleSpawnRequest(message: TeamMessage): void {
		const payload = (message.payload ?? {}) as {
			task?: string; name?: string; requestId?: string;
			provider?: string; model?: string; thinking?: string;
		};
		if (!payload.task) return;
		try {
			const ref = this.spawnTask(payload.name || "", payload.task, {
				parent: message.from,
				provider: payload.provider,
				model: payload.model,
				thinking: payload.thinking,
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
	 *  GC'd with the parent; it is exempt from fork-idle GC. The session
	 *  file is left intact (no spawn marker), so it stays in `/resume`
	 *  after the fork is reaped. */
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
		// A spawned fork gets its shell identity from teammateEnv at
		// launch; an attached session is already running, so its shell
		// tools would otherwise expand an empty $TEAM_PARENT_ID in the
		// report command. Apply the fork identity to this process's env.
		this.applyAttachEnv(forkId, session);
		try {
			unlinkSync(previousBusy);
		} catch {
			// absent, or the broker's orphan sweep reaps it
		}
		this.hold(this.cwd, true);
		this.announced = false;
		try {
			await this.send(parent, "notice",
				`attached ${forkId} (${session})`);
		} catch (error) {
			// The target never learned about the attach, so roll the
			// identity, env, and hold back instead of leaving a
			// half-attached session behind.
			this.detach();
			throw error;
		}
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
		this.restoreMainEnv();
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
		if (this.hasParent()) {
			throw new Error(
				"an agent belongs to one team; a teammate cannot attach " +
				"- ask your parent to attach it (team_attach)");
		}
		await this.requireAttachable(target);
		if (this.closed) return null;
		const id = requestId("attach");
		const pending = this.pending.register(id, 15000);
		await this.send(target, "attach", JSON.stringify(
			{ requestId: id, name }));
		return pending;
	}

	/** Another agent asked this running session to become its teammate:
	 *  this session owns the identity change. */
	private async handleAttachRequest(message: TeamMessage): Promise<void> {
		const payload = (message.payload ?? {}) as {
			name?: string; requestId?: string;
		};
		if (this.hasParent()) {
			void this.send(message.from, "attach-error", JSON.stringify({
				requestId: payload.requestId, why: "already-a-teammate",
			}));
			return;
		}
		// One-parent model, requester side: a fork (already a teammate)
		// must not attach a parent of its own, so only a root's attach
		// request converts this session. The requester's registry entry is
		// the evidence; an unknown sender is treated as a root.
		const agents = await this.snapshot();
		const requester = agents.find((a) => a.id === message.from);
		if (requester && requester.parent) {
			void this.send(message.from, "attach-error", JSON.stringify({
				requestId: payload.requestId, why: "requester-is-teammate",
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
		await this.brokerOps.terminate(agentId);
	}

	/** The common teammate template: the caller supplies only the task and
	 *  an optional name; session, model, and the report-back instruction
	 *  are supplied here. Like a subagent delegation, the teammate gets
	 *  the task alone and a clean context; unlike a subagent it stays a
	 *  persistent, resumable RPC session. */
	spawnTask(name: string, task: string, options: SpawnOptions = {}): TeammateRef {
		const forkId = this.makeForkId();
		const session = name || forkId;
		const args = this.teammateArgs(session, options);
		this.launchTeammate(forkId, session, args,
			this.taskPrompt(session, task), options.parent);
		return { id: forkId, session };
	}

	/** The spawn argv for a teammate: a headless RPC session, not a
	 *  one-shot `pi -p`, that inherits the parent's session directory,
	 *  provider, model, and thinking level. The context itself is never
	 *  inherited: like a subagent, a teammate starts clean. Every
	 *  teammate carries the general teammate role as its appended
	 *  system prompt, independent of its task. */
	private teammateArgs(
		session: string,
		options: SpawnOptions,
	): string[] {
		return [
			"--mode", "rpc",
			...(this.sessionDir ? ["--session-dir", this.sessionDir] : []),
			"--name", session,
			"--append-system-prompt", this.teammateRole.systemPrompt,
			...(options.provider ? ["--provider", options.provider] : []),
			...(options.model ? ["--model", options.model] : []),
			...(options.thinking ? ["--thinking", options.thinking] : []),
		];
	}

	private makeForkId(): string {
		return this.makeId("fork");
	}

	private taskPrompt(session: string, task: string): string {
		// The marker phrase here is the broker's teammate-session stamp; keep
		// it in sync with TEAMMATE_MARKER in src/team_root.py. The role itself
		// rides in the appended system prompt; this prompt carries only the
		// session identity, the report mechanics, and the task. Call the
		// interpreter on the absolute client path instead of a
		// `team` name on PATH: a shebang script is not executable on
		// Windows, and binDir may not be on PATH. The teammate runs this
		// through its shell tool, where the $TEAM_* variables expand.
		const send = this.reportCommand();
		return (
			`You are "${session}", a teammate spawned by a parent pi session ` +
			`to do one task. Report the outcome to your parent by running ` +
			`this command:\n  ${send}\n` +
			`Task:\n${task}`
		);
	}

	/** The report-back command, run through the interpreter on the
	 *  absolute client path (a shebang script is not executable on
	 *  Windows, and binDir may not be on PATH). Shared by the spawn
	 *  prompt and an attached teammate. Paths are single-quoted with
	 *  embedded quotes escaped, so no character in them can break out
	 *  of the teammate's shell command. */
	private reportCommand(): string {
		const quote = (value: string): string =>
			`'${value.replace(/'/g, "'\\''")}'`;
		return `${quote(this.python)} ${quote(teamBin)} --root "$TEAM_ROOT" ` +
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
			if (/^(PI_(SESSION|HOST)|TEAM_(ATTACHED|SESSION|HOST))/.test(key)) {
				delete env[key];
			}
		}
		Object.assign(env, {
			TEAM_ID: forkId,
			TEAM_NAME: session,
			TEAM_ROLE: "fork",
			TEAM_PARENT_ID: parent || this.id,
			TEAM_ROOT: stateRoot,
			// The teammate's own send credential: its hold registers with
			// it and its report-back shell command presents it.
			TEAM_SEND_TOKEN: mintSendToken(),
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

	/** Links a peer host's broker. The broker owns the ssh tunnel and
	 *  every transport detail; this asks it to add the peer and returns
	 *  the linked peer (label, advertised host, online, ssh). */
	async peerAdd(sshTarget: string, label: string): Promise<PeerInfo> {
		return this.brokerOps.peerAdd(label || sshTarget, sshTarget);
	}

	/** Removes a peer by its label or its advertised host label. */
	async peerRemove(name: string): Promise<void> {
		const peers = await this.brokerOps.peers();
		const match = peers.find(
			(p) => p.label === name || p.host === name);
		await this.brokerOps.peerRemove(match ? match.label : name);
	}

	/** The broker's linked peers (label, host, online, ssh). */
	async peers(): Promise<PeerInfo[]> {
		return this.brokerOps.peers();
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

	/** One inactivity watchdog for an active wait: a teammate that has
	 *  produced no work contact (report or control traffic) for the
	 *  stall bound looks hung, so it is nudged once with a steering
	 *  message telling it to continue or report. Nudges are recorded
	 *  per id so a silent teammate is never nagged in a loop. */
	private nudgeStalled(
		pending: string[],
		stallMs: number,
		lastActivity: number,
		nudged: Set<string>,
	): void {
		if (stallMs <= 0) return;
		if (Date.now() - lastActivity < stallMs) return;
		for (const id of pending) {
			if (nudged.has(id)) continue;
			nudged.add(id);
			void this.send(id, "text", STEER_NUDGE_TEXT)
				.catch(() => {
					// An undeliverable nudge is not a wait failure: the
					// bound or GC still ends the stale teammate.
				});
		}
	}

	/** Actively waits for teammates' results under the call's stop
	 *  conditions: the first result arrives, the bound elapses, the run
	 *  aborts (Escape), a user message is queued, or the session
	 *  deregisters. The first result ends the wait at once; the other
	 *  ids keep running and their later reports stay in the inbox. The
	 *  poll awaits between checks so the TUI stays responsive and the
	 *  wait stays steerable, and onTick fires each poll for progress
	 *  display. While the wait runs, an inactivity watchdog watches
	 *  every inbox contact and auto-sends a steering nudge to a
	 *  teammate that looks hung; each teammate is nudged at most once
	 *  per wait. Returns one entry per id, null when that teammate did
	 *  not report before the wait ended. */
	async waitForResults(
		agentIds: string[],
		timeoutMs: number,
		signal: AbortSignal | undefined,
		shouldYield: () => boolean,
		onTick?: () => void,
		stallMs = DEFAULT_STALL_SECONDS * 1000,
	): Promise<Array<TeamMessage | null>> {
		const results = new Map<string, TeamMessage>();
		const pending: string[] = [];
		for (const id of agentIds) {
			const buffered = this.inbox.take(id);
			if (buffered) results.set(id, buffered);
			else pending.push(id);
		}
		// A buffered report already satisfies the first-result trigger,
		// so return it now instead of holding the wait open.
		const canWait = results.size === 0 && pending.length > 0
			&& !this.closed && !signal?.aborted && !shouldYield();
		if (canWait) {
			await new Promise<void>((resolve) => {
				const unwatchers: Array<() => void> = [];
				let timer: ReturnType<typeof setTimeout> | undefined;
				let poll: ReturnType<typeof setInterval> | undefined;
				let settled = false;
				// The watchdog clock starts when the wait does and every
				// teammate contact pushes it forward, so only true silence
				// reaches the stall bound.
				let lastActivity = Date.now();
				const nudged = new Set<string>();
				const watching = new Set(pending);
				const onActivity = (from: string): void => {
					if (watching.has(from)) lastActivity = Date.now();
				};
				this.activityHook = onActivity;
				const finish = (): void => {
					if (settled) return;
					settled = true;
					this.activityHook = null;
					if (timer) clearTimeout(timer);
					if (poll) clearInterval(poll);
					signal?.removeEventListener("abort", onAbort);
					for (const unwatch of unwatchers) unwatch();
					resolve();
				};
				const onAbort = (): void => finish();
				for (const id of pending) {
					const unwatch = this.inbox.watch(id, (message) => {
						lastActivity = Date.now();
						if (!message) {
							finish();
							return;
						}
						results.set(id, message);
						// The first result ends the wait; the unwatchers
						// below free the other ids' watchers, and their
						// later reports stay buffered in the inbox.
						finish();
					});
					unwatchers.push(unwatch);
				}
				// Every resource is created before the first stop check,
				// so a wait that ends at once still releases all of them.
				const effective = timeoutMs > 0
					? timeoutMs : DEFAULT_WAIT_SECONDS * 1000;
				timer = setTimeout(finish, effective);
				poll = setInterval(() => {
					this.nudgeStalled(
						pending, stallMs, lastActivity, nudged);
					onTick?.();
					if (this.closed || signal?.aborted || shouldYield()) {
						finish();
					}
				}, WAIT_POLL_MS);
				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) finish();
				}
			});
		}
		return agentIds.map((id) => results.get(id) ?? null);
	}

	private cancelWaits(): void {
		// Deregister is terminal: a race that registers a pending request
		// after this point must resolve at once instead of leaking a timer.
		this.closed = true;
		this.pending.cancelAll();
		this.inbox.cancelAll();
	}

	deregister(): void {
		this.cancelWaits();
		this.stopHold();
		this.stopTeammates();
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
	const lines = agents
		.slice(0, 8)
		.map((a) =>
			`- ${a.id} ${a.name} (${a.role}, ${a.online ? "online" : "offline"}` +
			(a.session ? `, session ${basename(a.session)}` : "") +
			`)`);
	const content =
		`## pi-teams teammates (broker: ${stateRoot})\n` +
		`${lines.join("\n") || "- none live yet"}\n` +
		`Spawn a teammate with team_spawn (task, name); message, wait, ` +
		`attach, detach, and terminate are tool calls only (team_send, ` +
		`team_wait, team_attach, team_detach, team_kill). A teammate ` +
		`may only message its own team, so ask your parent to attach an ` +
		`outsider first, and an agent belongs to one team. Peer hosts: ` +
		`team_peer add <ssh-host>, then team_spawn host=<label>. The ` +
		`/team-ls command opens the teammates dock.`;
	return { customType: "pi-teams", content, display: false };
	}
}
