/**
 * TeamAgent: the pi session's live identity and every team operation. It
 * owns the hold connection, the spawn bookkeeping, the waiter inbox, and
 * lifecycle cleanup. Identity is read from the environment once, then
 * owned here.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { basename, dirname, join } from "node:path";

import {
	persistPiInvocation,
	piInvocationEnv,
	stateRoot,
	teamBin,
	teamdBin,
	writeStateFile,
} from "./paths.ts";
import { settings } from "./settings.ts";
import { WaitController, type WaitOutcome } from "./wait.ts";
import type { ProcessHost, SpawnedProcess } from "./process-runner.ts";
import {
	resolvePython,
	WindowlessPython,
	type InterpreterResolver,
} from "./interpreter.ts";
import { BrokerOps, type PeerInfo } from "./broker-ops.ts";
import type { AgentInfo } from "./directory.ts";
import {
	SpawnService,
	type SpawnOptions,
	type TeammateRef,
} from "./spawn.ts";
import { ResultInbox } from "./inbox.ts";
import type { TranscriptRef } from "./wait-stream.ts";
import {
	mintSendToken,
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
	 *  the spawn op present it. */
	private sendToken: string;
	private parent = "";
	private closed = false;
	private surrendered = false;
	private cwd = "";
	private announced = false;
	private holdProc: SpawnedProcess | null = null;
	private holdStartedAt = 0;
	private holdRestarts = 0;
	private readonly brokerOps: BrokerOps;
	private readonly spawns: SpawnService;
	private readonly inbox = new ResultInbox();
	// The active-wait owner (wait poll, stall nudge, contact hook).
	private readonly waits: WaitController;
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
		this.host = settings.host();
		// A main's id is minted at first hold (once the session file is
		// known) and derives from the session stem, surviving restarts
		// and reloads; TEAM_ID pins a fork's id from spawn.
		this.id = process.env.TEAM_ID || "";
		this.role = process.env.TEAM_ID ? "fork" : "main";
		this.parent = process.env.TEAM_PARENT_ID || "";
		// One send token per session: the hold registers with it and the
		// gated broker ops (send, spawn) present it.
		this.sendToken = process.env.TEAM_SEND_TOKEN || mintSendToken();
		this.brokerOps = new BrokerOps(runner, this.python);
		this.brokerOps.sendToken = this.sendToken;
		this.spawns = new SpawnService(
			this.host, this.brokerOps,
			() => this.id, () => this.cwd || process.cwd());
		this.waits = new WaitController(
			this.inbox,
			(to, kind, text) => this.send(to, kind, text),
			() => this.closed,
		);
	}

	/** A fresh agent id: host label (peers route by its prefix), kind
	 *  (`pi` main, `fork` teammate), and a suffix - session stem when
	 *  stability matters, random token otherwise. */
	private makeId(kind: string, suffix?: string): string {
		return `${this.host}:${kind}-${process.pid}-` +
			(suffix || Math.random().toString(16).slice(2, 10));
	}

	private makeMainId(): string {
		// The stem keeps one identity across hold restarts and reloads
		// (a random suffix minted one per process load and let a
		// session register twice); it is unique per session.
		return this.makeId("pi", this.identitySuffix() || undefined);
	}

	/** Mints the main id once, at first hold. */
	private ensureId(): string {
		if (!this.id) this.id = this.makeMainId();
		return this.id;
	}

	/** The pi session stem: one stable identity token per session. */
	private sessionStem(): string {
		return this.sessionFile
			? basename(this.sessionFile).replace(/\.jsonl$/i, "")
			: "";
	}

	/** A session-stable id suffix: the sanitized session stem. */
	private identitySuffix(): string {
		return this.sessionStem().replace(/[^A-Za-z0-9]/g, "-").slice(0, 32);
	}

	/** One launch path for every spawn shape (hidden hold, detached
	 *  teammate, persistent broker): a failed start never crashes the
	 *  session; the next agent action retries. */
	private launch(
		kind: "hidden" | "detached" | "persistent",
		file: string,
		args: string[],
		options: Record<string, unknown>,
	): SpawnedProcess | null {
		const spawn = kind === "persistent"
			? (f: string, a: string[], o: Record<string, unknown>) =>
				this.runner.spawnPersistent(f, a, o)
			: kind === "detached"
			? (f: string, a: string[], o: Record<string, unknown>) =>
				this.runner.spawnDetached(f, a, o)
			: (f: string, a: string[], o: Record<string, unknown>) =>
				this.runner.spawnHidden(f, a, o);
		const child = spawn(file, args, options);
		child?.on("error", () => {
			// A failed broker/hold/pi start must not crash the session;
			// the next agent action retries.
		});
		return child;
	}

	ensureBroker(): void {
		// Persist the launch entry before anything else: a broker started
		// by an older extension is already up without it and can only
		// learn the runtime from this file.
		persistPiInvocation();
		// The broker owns its restart policy (it exits once idle after
		// a source change and the next start adopts the new code), so
		// a reload never kills live work. Start one only when nothing
		// is published; a published endpoint is probed (a stale one
		// once blocked every hold).
		const endpointPath = join(stateRoot, "endpoint");
		if (!existsSync(endpointPath)) {
			this.startBroker();
			return;
		}
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
		const child = this.launch(
			"persistent",
			interpreter,
			[teamdBin, "--root", stateRoot, "start"],
			{
				stdio: "ignore",
				env: { ...process.env, ...piInvocationEnv() },
			},
		);
		child?.unref();
	}

	hold(cwd?: string): void {
		if (cwd) this.cwd = cwd;
		this.stopHold();
		this.ensureId();
		const name = this.registryName();
		const busyFile = this.busyFile();
		const env = this.holdEnv(name, this.role, this.parent, busyFile);
		// The client exits on stdin EOF, so the pipe must be owned by
		// this process: closing it (when pi goes away) drops the
		// endpoint instead of leaving an orphan pinging forever. Its
		// stdout carries inbound messages for the agent.
		const proc = this.launch(
			"hidden",
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

	/** Registry display name: the pi session stem when the session
	 *  file is known, so re-held and resumed sessions keep one name and
	 *  mains no longer collide as pi@cwd; spawned forks keep their
	 *  assigned shell names. */
	private registryName(): string {
		const stem = this.sessionStem();
		if (this.role !== "fork" && stem) return stem.slice(0, 48);
		if (process.env.TEAM_NAME) return process.env.TEAM_NAME;
		if (stem) return stem.slice(0, 48);
		return `pi@${this.cwd || process.cwd()}`;
	}

	/** A hold that died on its own (broker restart, post-reload idle
	 *  exit) leaves the session deaf until the next session event:
	 *  relaunch with bounded backoff. An intentional stop clears
	 *  holdProc before killing, so only unexpected deaths arrive. */
	private holdDied(proc: SpawnedProcess): void {
		if (this.holdProc !== proc) return;
		this.holdProc = null;
		if (this.closed || this.surrendered) return;
		// A hold that ran a while resets the backoff: this death is a
		// new failure, not a repeat of the previous one.
		if (Date.now() - this.holdStartedAt > 60000) this.holdRestarts = 0;
		this.holdRestarts += 1;
		// No retry cap: a restarted broker must always be able to bring
		// the session back, so the bounded backoff keeps retrying.
		const delay = Math.min(30000, 1000 * 2 ** this.holdRestarts);
		const timer = setTimeout(() => {
			if (this.closed || this.holdProc) return;
			this.ensureBroker();
			this.hold(this.cwd);
		}, delay);
		timer.unref?.();
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
		if (message.kind === "attach" || message.kind === "attach-ack" ||
			message.kind === "attach-error") {
			// Attachment is gone: answer an old session's request so it
			// learns why, and consume the replies old sessions send us
			// instead of surfacing control traffic as a task.
			if (message.kind === "attach") this.refuseAttach(message);
			return;
		}
		if (message.kind === "gc-reap") {
			// The broker has asked this idle session to reap itself.
			// The request steers a turn; the agent answers by calling
			// team_gc_reap, which acks and shuts the session down.
			this.deliver(this.reapRequest(message));
			return;
		}
		// Any inbound contact counts as the sender being alive for the
		// active wait's stall watchdog; results are handled below.
		if (message.from) this.waits.onContact(message.from);
		// A result first goes to an active team_wait, which consumes it as
		// the tool result; when none is waiting it is buffered and still
		// delivered as an ordinary message, so no report is ever lost.
		if (message.kind === "result" && message.to === this.id) {
			if (this.inbox.deliver(message)) return;
		}
		// A direct message must not sit behind a blocked team_wait: end
		// the wait so the steer below surfaces now. A notice is
		// bookkeeping and never wakes a wait.
		if (message.to === this.id && message.kind !== "notice") {
			this.waits.onMessage(message);
		}
		this.deliver(message);
	}

	/** Answers an attach request from a session still running the
	 *  removed protocol: every registered session is reachable, so there
	 *  is nothing left to attach. The request carries its id as JSON
	 *  text, so it is parsed back and echoed to settle the old sender. */
	private refuseAttach(message: TeamMessage): void {
		let requestId: unknown;
		try {
			const payload = typeof message.payload === "string"
				? JSON.parse(message.payload)
				: message.payload;
			requestId = (payload as { requestId?: unknown })?.requestId;
		} catch {
			// A malformed payload names no request to answer.
		}
		this.send(message.from, "attach-error", JSON.stringify({
			requestId, why: "attach-removed",
		})).catch(() => {
			// The requester is gone; there is nobody to tell.
		});
	}

	/** Rewrites the broker's idle reap request into the instruction the
	 *  agent must act on: call team_gc_reap to acknowledge and shut this
	 *  session down. The broker's why and idle window ride along. */
	private reapRequest(message: TeamMessage): TeamMessage {
		const payload = (message.payload ?? {}) as {
			why?: unknown; hours?: unknown;
		};
		const why = typeof payload.why === "string" ? payload.why : "idle";
		const hours = typeof payload.hours === "number" ? payload.hours : 3;
		return {
			...message,
			payload:
				`The broker asks this session to reap itself after ` +
				`${hours}h idle (why: ${why}). Call the team_gc_reap ` +
				`tool now to acknowledge and shut this session down. If ` +
				`you are in fact working, send the broker a message and ` +
				`keep working; the request is not a forced kill.`,
		};
	}

	/** The voluntary reap the team_gc_reap tool performs: tell the
	 *  broker to drop this registration and its files. The caller owns
	 *  the orderly process shutdown (ctx.shutdown()). */
	async reap(): Promise<void> {
		await this.brokerOps.gcReap(this.id, this.sendToken);
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

	/** Publishes the agent's run-state (busy keeps a fork alive, idle
	 *  does not, waiting is blocked in a team_wait). The write is
	 *  atomic: the hold's heartbeat must never see it torn. */
	setState(state: "busy" | "idle" | "waiting"): void {
		const value = state === "busy" ? "1" : state === "waiting" ? "2" : "0";
		try {
			writeStateFile(`${this.stateFileName()}.busy`, value);
		} catch {
			// best effort: without the flag the fork is GC'd like an idle one
		}
	}

	/** This agent's state file name. The id carries a host label, whose
	 *  colon is illegal in a Windows filename, so the id is sanitized. */
	private stateFileName(): string {
		this.ensureId();
		return this.id.replace(/[^A-Za-z0-9._-]/g, "-");
	}

	private busyFile(): string {
		return join(stateRoot, `${this.stateFileName()}.busy`);
	}

	async snapshot(): Promise<AgentInfo[]> {
		return this.brokerOps.snapshot();
	}

	/** The local transcript of `target` (default this session) for
	 *  team_peek. Throws with the fix when it is not readable here. */
	async transcriptOf(
		target?: string,
	): Promise<{ id: string; path: string }> {
		if (!target || target === this.id) {
			if (!this.sessionFile) {
				throw new Error("this session has no transcript file");
			}
			return { id: this.id || "this session", path: this.sessionFile };
		}
		const ref = this.locate(target, await this.snapshot());
		if (!ref.path) throw new Error(ref.error);
		return { id: ref.id, path: ref.path };
	}

	/** The local transcripts of `ids` for the live team_wait stream: one
	 *  registry snapshot for all of them, and a per-id reason when a
	 *  transcript is not readable from this host. */
	async transcriptsOf(ids: readonly string[]): Promise<TranscriptRef[]> {
		const agents = await this.snapshot();
		return ids.map((id) => this.locate(id, agents));
	}

	/** Resolves one id against an already-fetched registry snapshot. */
	private locate(target: string, agents: AgentInfo[]): TranscriptRef {
		const entry = agents.find((a) => a.id === target);
		if (!entry) {
			return {
				id: target,
				error: `no registered agent ${target}; run team_ls for ids`,
			};
		}
		if (entry.remote || (entry.origin && entry.origin !== this.host)) {
			return {
				id: target,
				peer: true,
				error: `${target} runs on peer ${entry.origin ?? "host"}; its ` +
					"transcript is not readable from this host",
			};
		}
		if (!entry.session) {
			return {
				id: target,
				error: `${target} has not recorded a transcript yet; ` +
					"retry shortly",
			};
		}
		return { id: target, path: entry.session };
	}

	async send(to: string, kind: string, text: string): Promise<string> {
		// The peer's spawn handler replies to the message's `from`, and a
		// spawned fork is parented to it, so an unregistered sender would
		// strand both. Hand this agent's id to the transient client.
		return this.brokerOps.send(to, kind, text, this.id, this.sendToken);
	}

	/** Spawns a teammate on `host` (empty or this host = local) behind a
	 *  single interface; the broker owns the spawn contract and routes a
	 *  peer host over its link. */
	async spawn(
		host: string,
		name: string,
		task: string,
		options: SpawnOptions = {},
	): Promise<TeammateRef> {
		this.ensureBroker();
		const session = name || this.defaultSessionName(task);
		const ref = await this.spawns.spawn(host, session, task, {
			...options,
			parent: options.parent || this.id,
		});
		return ref;
	}

	async terminate(agentId: string): Promise<void> {
		await this.brokerOps.terminate(this.ensureId(), agentId,
			this.sendToken);
	}

	/** The session name for a spawn that carried none: a short slug of
	 *  the task. Falling back to the generated agent id (as it once did)
	 *  left the session without a usable name - the dock hides a name
	 *  equal to the id, and /resume shows the raw id. */
	private defaultSessionName(task: string): string {
		const slug = String(task || "")
			.replace(/\s+/g, " ")
			.trim()
			.replace(/[^\w .:+-]+/g, "")
			.trim()
			.slice(0, 48)
			.replace(/[ .:+-]+$/, "");
		return slug || "teammate";
	}

	/** The report-back command, run through the interpreter on the
	 *  absolute client path (a shebang script is not executable on
	 *  Windows, and binDir may not be on PATH). Paths are single-quoted
	 *  with embedded quotes escaped, so no character in them can break
	 *  out of the teammate's shell command. */
	private reportCommand(): string {
		const quote = (value: string): string =>
			`'${value.replace(/'/g, "'\\''")}'`;
		return `${quote(this.python)} ${quote(teamBin)} --root "$TEAM_ROOT" ` +
			`send "$TEAM_PARENT_ID" result "<report>"`;
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

	/** Delegates to the wait owner: one active wait with its stall
	 *  watchdog and liveness hook, never a leaked timer. */
	async waitForResults(
		agentIds: string[],
		timeoutMs: number,
		signal: AbortSignal | undefined,
		shouldYield: () => boolean,
		onTick?: () => void,
		stallMs?: number,
		startedAt?: number,
	): Promise<WaitOutcome> {
		return this.waits.waitForResults(
			agentIds, timeoutMs, signal, shouldYield, onTick, stallMs, startedAt);
	}

	private cancelWaits(): void {
		// Deregister is terminal: a buffered result resolves at once
		// instead of outliving the session.
		this.closed = true;
		this.inbox.cancelAll();
	}

	deregister(): void {
		// A surrendered instance handed its identity to a reload's
		// replacement: touching state here would tear down the
		// registration the fresh instance now owns.
		if (this.surrendered) return;
		this.cancelWaits();
		this.stopHold();
		this.clearState();
	}

	/** Reload handover, replacement side: continue the previous
	 *  instance's id and send token so the registry entry and parked
	 *  mail survive the swap; a fresh identity would orphan both. */
	inheritIdentity(previous: TeamAgent): void {
		if (previous.id) this.id = previous.id;
		if (previous.sendToken) this.sendToken = previous.sendToken;
		this.brokerOps.sendToken = this.sendToken;
	}

	/** Reload handover, replaced side: stop this instance's hold and
	 *  waits without deregistering; holdDied must not resurrect it
	 *  into a duplicate registration. */
	handover(): void {
		this.surrendered = true;
		this.cancelWaits();
		this.stopHold();
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
}
