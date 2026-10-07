/**
 * Regression tests for the pi-teams extension.
 *
 * Every child launch goes through ProcessRunner, which sets windowsHide
 * so no console window flashes on Windows. The hold and forked pi are
 * launched with Node's child_process directly rather than pi.exec:
 * pi.exec opens a child's stdin to /dev/null and silently drops the env
 * option, so the extension must own that launch:
 *   - hold keeps a stdin pipe owned by this process (EOF == pi gone)
 *     and forwards the agent identity through the environment;
 *   - spawn asks the broker's spawn op, which owns the session
 *     contract for local and peer hosts; the extension launches no pi
 *     child for a teammate, and there is no peer main-agent relay;
 *   - attached sessions keep their own identity and report mechanics.
 *
 * Runs on Node's built-in test runner; the extension is imported with
 * Node's TypeScript stripping. No broker or pi process is started.
 */

import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "pi-teams-ext-"));
const stateRoot = join(scratch, "state");
const binDir = join(scratch, "bin");
const sessionDir = join(scratch, "sessions");
// The suite must run identically inside a pi-teams fork, whose process
// environment already carries TEAM_NAME/TEAM_ID/TEAM_ROLE; strip them so
// ambient identity can never leak into the assertions below.
for (const key of Object.keys(process.env)) {
	if (key.startsWith("TEAM_")) delete process.env[key];
}
process.env.TEAM_ROOT = stateRoot;
process.env.PI_TEAMS_BIN = binDir;
// Pin the interpreter so resolvePython() is deterministic across
// platforms (on Windows it may otherwise probe to `python`/`py`).
process.env.PYTHON = process.env.PYTHON || "python3";
process.env.PI_SESSION_FILE = join(scratch, "session.jsonl");
process.env.TEAM_ID = "parent-1";

const { TeamAgent, ProcessRunner, PendingRequests,
	WindowlessPython, windowlessCandidates, logTeamMessage, AgentDirectory,
	ResultInbox } =
	await import("../extensions/pi-teams.ts");
const { PackageSettings } =
	await import("../extensions/pi-teams/settings.ts");
const { TeamSettingsPresenter } =
	await import("../extensions/pi-teams/settings-presenter.ts");
const { SettingsStore } =
	await import("../extensions/pi-teams/settings-store.ts");
const { TeamSettingsView } =
	await import("../extensions/pi-teams/settings-view.ts");
const { formatReport } =
	await import("../extensions/pi-teams/messages.ts");
const { PreTeamsTool } =
	await import("../extensions/pi-teams/pre-teams.ts");
const { persistPiInvocation, piEntryFile } =
	await import("../extensions/pi-teams/paths.ts");

process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

test("persistPiInvocation writes the durable launch record", () => {
	const path = join(stateRoot, piEntryFile);
	if (existsSync(path)) unlinkSync(path);
	persistPiInvocation();
	const record = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(record.version, 1);
	assert.ok(record.entry, "no runtime entry was recorded");
	assert.ok(record.node, "no runtime command was recorded");
	assert.equal(existsSync(record.entry), true);
	assert.equal(record.args, undefined);
});

function spawnStub(calls, file, args, options) {
	const record = {
		file,
		args,
		options,
		stdinEnded: false,
		stdinWrites: [],
		killed: false,
		unrefed: false,
	};
	calls.push(record);
	return {
		stdin: {
			end() {
				record.stdinEnded = true;
			},
			write(data) {
				record.stdinWrites.push(data);
			},
		},
		stdout: {
			on(event, listener) {
				record["stdout:" + event] = listener;
			},
		},
		stderr: {
			on(event, listener) {
				record["stderr:" + event] = listener;
			},
		},
		on(event, listener) {
			record["on:" + event] = listener;
		},
		unref() {
			record.unrefed = true;
		},
		kill() {
			record.killed = true;
		},
	};
}

function makeSpawn() {
	const calls = [];
	const spawnProcess = (file, args, options) =>
		spawnStub(calls, file, args, options);
	return { calls, spawnProcess };
}

/** A fake ProcessHost: records spawns and runs a caller-supplied run. */
function makeRunner(run) {
	const calls = [];
	const runner = {
		run: run ?? (() =>
			Promise.resolve({ stdout: "{}", stderr: "", code: 0 })),
		spawnHidden(file, args, options = {}) {
			return spawnStub(calls, file, args, {
				...options, windowsHide: true,
			});
		},
		spawnDetached(file, args, options = {}) {
			return spawnStub(calls, file, args, {
				...options, windowsHide: true,
				detached: process.platform !== "win32",
			});
		},
		spawnPersistent(file, args, options = {}) {
			return spawnStub(calls, file, args, {
				...options, windowsHide: true, detached: true,
			});
		},
	};
	return { calls, runner };
}

function makeAgent(deliver = () => {}) {
	const { calls, runner } = makeRunner();
	const windowless = (python) => new WindowlessPython(python, () => false);
	return {
		agent: new TeamAgent(runner, deliver, windowless),
		calls,
	};
}

function publishEndpoint(present) {
	mkdirSync(stateRoot, { recursive: true });
	const endpoint = join(stateRoot, "endpoint");
	if (present) {
		writeFileSync(endpoint, "{}\n");
	} else if (existsSync(endpoint)) {
		unlinkSync(endpoint);
	}
}

test("hold forwards identity and owns the held connection's stdin", () => {
	const { agent, calls } = makeAgent();
	agent.hold("/work");
	assert.equal(calls.length, 1);
	const call = calls[0];
	assert.equal(call.file, process.env.PYTHON || "python3");
	assert.deepEqual(call.args, [join(binDir, "team"), "--root", stateRoot, "hold"]);
	assert.deepEqual(call.options.stdio, ["pipe", "pipe", "ignore"]);
	assert.equal(call.options.env.TEAM_ID, agent.id);
	assert.equal(call.options.env.TEAM_OWNER_PID, String(process.pid));
	assert.equal(call.options.env.TEAM_NAME, "pi@/work");
	assert.ok(call.options.env.TEAM_BUSY_FILE.endsWith(`${agent.id}.busy`));
	assert.ok(call.options.env.TEAM_SEND_TOKEN, "hold must carry a send token");

	agent.stopHold();
	assert.equal(call.stdinEnded, true);
	assert.equal(call.killed, true);
});

test("hold replaces a previous held connection", () => {
	const { agent, calls } = makeAgent();
	agent.hold("/one");
	agent.hold("/two");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].killed, true);
	assert.equal(calls[1].killed, false);
	agent.stopHold();
	assert.equal(calls[1].killed, true);
});

test("a dead hold re-holds without a retry cap", () => {
	const { agent } = makeAgent();
	agent.hold("/work");
	const proc = agent.holdProc;
	assert.ok(proc, "hold registered a child");
	// A long outage has exhausted the old five-retry cap; the next
	// expiry must still schedule the re-hold.
	agent.holdRestarts = 6;
	const scheduled = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, delay) => {
		scheduled.push({ fn, delay });
		return 0;
	};
	try {
		agent.holdDied(proc);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	assert.equal(agent.holdProc, null, "holdDied kept the dead hold");
	assert.equal(agent.holdRestarts, 7, "restart count did not advance");
	assert.equal(scheduled.length, 1,
		"an exhausted session must still schedule a re-hold");
	assert.ok(scheduled[0].delay <= 30000, "backoff stays bounded");
	agent.stopHold();
});

test("logTeamMessage records a truncated sent/received log entry", () => {
	const entries = [];
	const pi = { appendEntry: (type, data) => entries.push({ type, data }) };
	logTeamMessage(pi, "received", {
		from: "kid", to: "parent", kind: "result", payload: "x".repeat(200),
	});
	assert.equal(entries.length, 1);
	assert.equal(entries[0].type, "pi-teams-log");
	assert.equal(entries[0].data.direction, "received");
	assert.equal(entries[0].data.payload.length, 200);
	assert.equal(entries[0].data.preview.length, 96);
	assert.ok(entries[0].data.preview.endsWith("..."));

	logTeamMessage(pi, "sent", {
		from: "parent", to: "kid", kind: "task", payload: "short",
	});
	assert.equal(entries.length, 2);
	assert.equal(entries[1].data.direction, "sent");
	assert.equal(entries[1].data.preview, "short");
});

test("announceSession notices the parent of the fork's session file", async () => {
	const runCalls = [];
	const { runner } = makeRunner(async (_file, args) => {
		runCalls.push(args);
		return { stdout: "{}", stderr: "", code: 0 };
	});
	const agent = new TeamAgent(runner, () => {});
	process.env.TEAM_PARENT_ID = "parent-9";
	try {
		await agent.announceSession("/x/sessions/sess.jsonl");
		assert.equal(runCalls.length, 1);
		const args = runCalls[0];
		assert.ok(args.includes("send"));
		assert.ok(args.includes("parent-9"));
		assert.ok(args.includes("notice"));
		assert.ok(args.some((a) => a.includes("sess.jsonl")));

		// No parent: nothing is sent.
		delete process.env.TEAM_PARENT_ID;
		await agent.announceSession("/x/sessions/sess.jsonl");
		assert.equal(runCalls.length, 1);

		// No session file: nothing is sent.
		process.env.TEAM_PARENT_ID = "parent-9";
		await agent.announceSession(null);
		assert.equal(runCalls.length, 1);
	} finally {
		delete process.env.TEAM_PARENT_ID;
	}
});

test("hold forwards inbound messages to the agent", () => {
	const received = [];
	const { agent, calls } = makeAgent((message) => received.push(message));
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	assert.equal(typeof onData, "function");

	onData(JSON.stringify({
		from: "kid", to: agent.id, kind: "result", payload: "done",
	}) + "\n");
	assert.equal(received.length, 1);
	assert.deepEqual(received[0], {
		from: "kid", to: agent.id, kind: "result", payload: "done",
	});

	// A partial line waits for its newline, then delivers.
	onData('{"from":"kid","to":"p","kind":"text"');
	assert.equal(received.length, 1);
	onData(',"payload":"x"}\n');
	assert.equal(received.length, 2);
	assert.equal(received[1].payload, "x");

	agent.stopHold();
});

test("a result is delivered as a message, not held by a waiter", () => {
	const received = [];
	const { agent, calls } = makeAgent((message) => received.push(message));
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	onData(JSON.stringify({
		from: "kid", to: agent.id, kind: "result", payload: "done",
	}) + "\n");
	// Waiting is passive: nothing consumes the report, so the agent sees
	// it as an ordinary message.
	assert.deepEqual(received.map((m) => m.payload), ["done"]);
	agent.stopHold();
});

test("an active wait consumes a result that arrives during it", async () => {
	const received = [];
	const { agent, calls } = makeAgent((message) => received.push(message));
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	const waiting = agent.waitForResults(["kid"], 5000, undefined,
		() => false);
	onData(JSON.stringify({
		from: "kid", to: agent.id, kind: "result", payload: "done",
	}) + "\n");
	const outcome = await waiting;
	assert.equal(outcome.results.length, 1);
	assert.equal(outcome.results[0].payload, "done");
	// The tool result owns it, so it is not also delivered as a message.
	assert.deepEqual(received, []);
	agent.stopHold();
});

test("a result that arrived early is returned by the next wait", async () => {
	const received = [];
	const { agent, calls } = makeAgent((message) => received.push(message));
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	onData(JSON.stringify({
		from: "kid", to: agent.id, kind: "result", payload: "early",
	}) + "\n");
	// No waiter: the report is delivered as a message and buffered.
	assert.deepEqual(received.map((m) => m.payload), ["early"]);
	const outcome = await agent.waitForResults(
		["kid"], 5000, undefined, () => false);
	assert.equal(outcome.results[0].payload, "early");
	agent.stopHold();
});

test("an active wait returns null on its bound", async () => {
	const { agent } = makeAgent();
	const outcome = await agent.waitForResults(
		["nobody"], 20, undefined, () => false);
	assert.deepEqual(outcome.results, [null]);
});

test("an active wait yields when a user message is queued", async () => {
	const { agent } = makeAgent();
	let pending = false;
	const waiting = agent.waitForResults(
		["kid"], 5000, undefined, () => pending);
	setTimeout(() => { pending = true; }, 20);
	assert.deepEqual((await waiting).results, [null]);
});

test("an active wait ends when the run aborts", async () => {
	const { agent } = makeAgent();
	const controller = new AbortController();
	const waiting = agent.waitForResults(
		["kid"], 5000, controller.signal, () => false);
	setTimeout(() => controller.abort(), 10);
	assert.deepEqual((await waiting).results, [null]);
});

test("deregister cancels an active wait", async () => {
	const { agent } = makeAgent();
	const waiting = agent.waitForResults(
		["kid"], 5000, undefined, () => false);
	await new Promise((resolve) => setTimeout(resolve, 10));
	agent.deregister();
	assert.deepEqual((await waiting).results, [null]);
});

test("a multi-id wait ends on the first result", async () => {
	const { agent, calls } = makeAgent(() => {});
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	const waiting = agent.waitForResults(
		["kid", "other"], 5000, undefined, () => false);
	onData(JSON.stringify({
		from: "other", to: agent.id, kind: "result", payload: "fast",
	}) + "\n");
	const outcome = await waiting;
	assert.equal(outcome.results[0], null);
	assert.equal(outcome.results[1].payload, "fast");
	agent.stopHold();
});

test("a buffered result ends a multi-id wait at once", async () => {
	const { agent, calls } = makeAgent(() => {});
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	onData(JSON.stringify({
		from: "kid", to: agent.id, kind: "result", payload: "early",
	}) + "\n");
	const outcome = await agent.waitForResults(
		["kid", "other"], 5000, undefined, () => false);
	assert.equal(outcome.results[0].payload, "early");
	assert.equal(outcome.results[1], null);
	agent.stopHold();
});

test("an active wait reports progress ticks", async () => {
	const { agent } = makeAgent();
	let ticks = 0;
	await agent.waitForResults(
		["nobody"], 600, undefined, () => false, () => { ticks += 1; });
	assert.ok(ticks >= 1);
});

test("a stalled wait nudges each silent teammate once", async () => {
	const runCalls = [];
	const { calls, runner } = makeRunner(async (file, args) => {
		runCalls.push(args);
		return { stdout: "{}", stderr: "", code: 0 };
	});
	const windowless = (python) => new WindowlessPython(python, () => false);
	const agent = new TeamAgent(runner, () => {}, windowless);
	const outcome = await agent.waitForResults(
		["kid", "other"], 700, undefined, () => false, undefined, 150);
	// Silence past the stall bound sends one nudge per teammate; the
	// 250ms poll fires several times but the nudge must not repeat.
	await new Promise((resolve) => setTimeout(resolve, 50));
	// The nudge goes through `team send --id <parent> --send-token <tok>
	// <to> text <text>`: the first positional after the flags is the
	// target id.
	const sendTarget = (args) => {
		const start = args.indexOf("send") + 1;
		for (let i = start; i < args.length; i += 2) {
			if (!args[i].startsWith("--")) return args[i];
		}
		return "";
	};
	const nudges = runCalls.filter((args) => args.includes("send"));
	assert.equal(nudges.length, 2,
		`expected one nudge per teammate, got ${nudges.length}`);
	const nudgeTargets = nudges.map(sendTarget);
	assert.deepEqual([...nudgeTargets].sort(), ["kid", "other"]);
	for (const args of nudges) {
		assert.ok(String(args[args.length - 1]).includes("continue"));
	}
	assert.deepEqual(outcome.results, [null, null]);
});

test("an active teammate message wakes the wait so it can steer", async () => {
	const received = [];
	const { agent, calls } = makeAgent((message) => received.push(message));
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	const waiting = agent.waitForResults(
		["kid"], 5000, undefined, () => false);
	onData(JSON.stringify({
		from: "kid", to: agent.id, kind: "text", payload: "need input",
	}) + "\n");
	const outcome = await waiting;
	assert.deepEqual(outcome.results, [null]);
	assert.equal(outcome.interruptedBy.payload, "need input");
	// The message still arrives as an ordinary steering message.
	assert.deepEqual(received.map((m) => m.payload), ["need input"]);
	agent.stopHold();
});

test("a message from outside the wait also wakes it", async () => {
	const received = [];
	const { agent, calls } = makeAgent((message) => received.push(message));
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	const waiting = agent.waitForResults(
		["kid"], 5000, undefined, () => false);
	onData(JSON.stringify({
		from: "other", to: agent.id, kind: "text", payload: "hello",
	}) + "\n");
	const outcome = await waiting;
	assert.deepEqual(outcome.results, [null]);
	assert.equal(outcome.interruptedBy.from, "other");
	assert.deepEqual(received.map((m) => m.payload), ["hello"]);
	agent.stopHold();
});

test("a notice resets the stall clock without waking the wait", async () => {
	const runCalls = [];
	const { calls, runner } = makeRunner(async (file, args) => {
		runCalls.push(args);
		return { stdout: "{}", stderr: "", code: 0 };
	});
	const windowless = (python) => new WindowlessPython(python, () => false);
	const agent = new TeamAgent(runner, () => {}, windowless);
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	const waiting = agent.waitForResults(
		["kid"], 600, undefined, () => false, undefined, 200);
	// A notice is bookkeeping: it resets the stall clock but never
	// wakes the wait, so a just-announced teammate is not nudged.
	for (const at of [100, 250, 400]) {
		setTimeout(() => onData(JSON.stringify({
			from: "kid", to: agent.id, kind: "notice", payload: "session",
		}) + "\n"), at);
	}
	const outcome = await waiting;
	assert.equal(outcome.interruptedBy, null);
	assert.deepEqual(outcome.results, [null]);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(runCalls.filter((args) => args.includes("send")).length, 0,
		"a noticed teammate was nudged anyway");
	agent.stopHold();
});

test("stall 0 disables the nudge", async () => {
	const runCalls = [];
	const { runner } = makeRunner(async (file, args) => {
		runCalls.push(args);
		return { stdout: "{}", stderr: "", code: 0 };
	});
	const windowless = (python) => new WindowlessPython(python, () => false);
	const agent = new TeamAgent(runner, () => {}, windowless);
	await agent.waitForResults(
		["kid"], 500, undefined, () => false, undefined, 0);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(runCalls.filter((args) => args.includes("send")).length, 0);
});

test("ResultInbox hands a result to its waiter exactly once", () => {
	const inbox = new ResultInbox();
	const seen = [];
	const unwatch = inbox.watch("kid", (message) => seen.push(message));
	assert.equal(inbox.deliver({
		from: "kid", to: "me", kind: "result", payload: "x",
	}), true);
	assert.equal(seen.length, 1);
	// The sender's waiter set is consumed, so a second result buffers.
	assert.equal(inbox.deliver({
		from: "kid", to: "me", kind: "result", payload: "y",
	}), false);
	assert.equal(inbox.take("kid").payload, "y");
	unwatch();
});

test("ResultInbox cancels every waiter and drops buffered results", () => {
	const inbox = new ResultInbox();
	const cancelled = [];
	inbox.watch("kid", (message) => cancelled.push(message));
	inbox.deliver({ from: "z", to: "me", kind: "result", payload: "x" });
	inbox.cancelAll();
	assert.deepEqual(cancelled, [null]);
	assert.equal(inbox.take("z"), undefined);
});

test("requireSameTeam lets a root reach any agent", async () => {
	const savedId = process.env.TEAM_ID;
	delete process.env.TEAM_ID;
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, () => {});
	if (savedId !== undefined) process.env.TEAM_ID = savedId;
	assert.equal(agent.hasParent(), false);
	await assert.doesNotReject(() => agent.requireSameTeam("outsider"));
});

test("requireSameTeam is team-scoped for a teammate", async () => {
	const { runner } = makeRunner((file, args) => {
		if (args.includes("ls")) {
			return Promise.resolve({ stdout: JSON.stringify({ agents: [
				{ id: "root", name: "r", role: "main", pid: 1, parent: null,
				  session: null, online: true },
				{ id: "sibling", name: "s", role: "fork", pid: 2,
				  parent: "root", session: null, online: true },
				{ id: "outsider", name: "o", role: "main", pid: 3,
				  parent: null, session: null, online: true },
			] }), stderr: "", code: 0 });
		}
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	await agent.attachTo("root", "me");
	await assert.doesNotReject(() => agent.requireSameTeam("sibling"));
	await assert.rejects(() => agent.requireSameTeam("outsider"),
		/outside your team/);
	agent.detach();
	agent.stopHold();
});

test("requireSameTeam frees an orphaned teammate to reach anyone", async () => {
	const savedId = process.env.TEAM_ID;
	const savedParent = process.env.TEAM_PARENT_ID;
	process.env.TEAM_ID = "fork-orphan";
	process.env.TEAM_PARENT_ID = "gone-parent";
	const { runner } = makeRunner((file, args) => {
		if (args.includes("ls")) {
			return Promise.resolve({ stdout: JSON.stringify({ agents: [
				{ id: "outsider", name: "o", role: "main", pid: 3,
				  parent: null, session: null, online: true },
			] }), stderr: "", code: 0 });
		}
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	if (savedId !== undefined) process.env.TEAM_ID = savedId;
	else delete process.env.TEAM_ID;
	if (savedParent !== undefined) process.env.TEAM_PARENT_ID = savedParent;
	else delete process.env.TEAM_PARENT_ID;
	agent.hold("/work");
	assert.equal(agent.hasParent(), true);
	assert.equal(await agent.isOrphaned(), true);
	await assert.doesNotReject(() => agent.requireSameTeam("outsider"));
	agent.detach();
	agent.stopHold();
});

test("a teammate-marked transcript keeps its session a member", async () => {
	const dir = mkdtempSync(join(scratch, "session-"));
	const file = join(dir, "sess.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session" }) + "\n" +
		JSON.stringify({ type: "message",
			content: "a teammate spawned by a parent pi session" }) + "\n");
	const savedId = process.env.TEAM_ID;
	delete process.env.TEAM_ID;
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, () => {});
	if (savedId !== undefined) process.env.TEAM_ID = savedId;
	else delete process.env.TEAM_ID;
	agent.rememberSession(file);
	assert.equal(agent.hasParent(), false);
	assert.equal(await agent.isTeammate(), true);
});

test("a gc-reap request steers the agent to call the reap tool", async () => {
	const delivered = [];
	const { calls, runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, (m) => delivered.push(m));
	agent.deliverMessage(JSON.stringify({
		op: "message", id: "f1", from: "*", to: "parent-1",
		kind: "gc-reap",
		payload: { id: "parent-1", why: "idle", hours: 3 },
		ts: 1,
	}));
	// The request steers a turn; the agent answers by calling the
	// team_gc_reap tool, so no broker op runs on its behalf here.
	assert.equal(calls.length, 0, "the reap was answered automatically");
	assert.equal(delivered.length, 1);
	const text = String(delivered[0].payload);
	assert.match(text, /team_gc_reap/);
	assert.match(text, /idle/);
	assert.match(text, /3h/);
});

test("an ordinary report is delivered without preemption", () => {
	const delivered = [];
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, (m) => delivered.push(m));
	agent.deliverMessage(JSON.stringify({
		op: "message", id: "r1", from: "kid", to: agent.id,
		kind: "result", payload: "done", ts: 1,
	}));
	assert.deepEqual(delivered.map((m) => m.payload), ["done"]);
});

test("deliverMessage filters a redelivered envelope id", async () => {
	const delivered = [];
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, (m) => delivered.push(m));
	const line = (id) => JSON.stringify({
		op: "message", id, from: "a", to: "parent-1",
		kind: "text", payload: "hi", ts: 1,
	});
	agent.deliverMessage(line("m1"));
	agent.deliverMessage(line("m1"));
	agent.deliverMessage(line("m2"));
	assert.equal(delivered.length, 2);
	assert.deepEqual(
		delivered.map((m) => m.id), ["m1", "m2"]);
});

test("attach refuses a target that already has a parent", async () => {
	const { runner } = makeRunner((file, args) => {
		if (args.includes("ls")) {
			return Promise.resolve({ stdout: JSON.stringify({ agents: [
				{ id: "taken", name: "t", role: "fork", pid: 1,
				  parent: "p", session: null, online: true },
			] }), stderr: "", code: 0 });
		}
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	await assert.rejects(() => agent.attach("taken", "x"), /one team/);
});

test("attachTo refuses a second parent", async () => {
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	await agent.attachTo("root", "me");
	await assert.rejects(() => agent.attachTo("other"), /one team/);
	agent.detach();
	agent.stopHold();
});

test("setState publishes busy, waiting, and idle to the busy file", () => {
	mkdirSync(stateRoot, { recursive: true });
	const { agent } = makeAgent();
	const busy = join(stateRoot, `${agent.id}.busy`);
	agent.setState("waiting");
	assert.equal(readFileSync(busy, "utf8"), "2");
	agent.setBusy(true);
	assert.equal(readFileSync(busy, "utf8"), "1");
	agent.setBusy(false);
	assert.equal(readFileSync(busy, "utf8"), "0");
});

test("spawning is one broker op with no local launch path", () => {
	const { agent } = makeAgent();
	assert.equal(typeof agent.spawn, "function");
	assert.equal(typeof agent.spawnTask, "undefined",
		"the local launch entry point is gone");
	assert.equal(typeof agent.parseSpawn, "undefined", "no argv parser");
});

test("spawn asks the broker's spawn op with session and options", async () => {
	publishEndpoint(true);
	const runs = [];
	const { calls, runner } = makeRunner((file, args) => {
		runs.push(args);
		return Promise.resolve({ stdout: JSON.stringify({
			ok: true, id: "fork-1", session: "worker",
		}), stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	const ref = await agent.spawn("", "worker", "do it", {
		provider: "openrouter", model: "m", thinking: "low",
	});
	assert.equal(ref.id, "fork-1");
	assert.equal(ref.session, "worker");
	const sent = runs.find((a) => a.includes("spawn"));
	assert.ok(sent, "no spawn op was sent to the broker");
	assert.equal(sent[sent.indexOf("--task") + 1], "do it");
	assert.equal(sent[sent.indexOf("--name") + 1], "worker");
	assert.equal(sent[sent.indexOf("--id") + 1], agent.id);
	assert.equal(sent[sent.indexOf("--send-token") + 1], agent.sendToken);
	assert.equal(sent[sent.indexOf("--parent") + 1], agent.id);
	assert.equal(sent[sent.indexOf("--provider") + 1], "openrouter");
	assert.equal(sent[sent.indexOf("--model") + 1], "m");
	assert.equal(sent[sent.indexOf("--thinking") + 1], "low");
	assert.ok(!sent.includes("--host"), "a local spawn carries no host");
	// The broker owns the launch: no pi child is started here.
	assert.equal(calls.length, 1, "spawn must not launch a pi child");
	agent.stopHold();
});

test("spawn names an unnamed spawn from its task", async () => {
	publishEndpoint(true);
	const runs = [];
	const { runner } = makeRunner((_file, args) => {
		runs.push(args);
		return Promise.resolve({ stdout: JSON.stringify({
			ok: true, id: "fork-2", session: "Summarize the diff please",
		}), stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	agent.rememberSession(join(sessionDir, "sess.jsonl"));
	const ref = await agent.spawn("", "", "Summarize the   diff\nplease");
	assert.equal(ref.session, "Summarize the diff please");
	const sent = runs.find((a) => a.includes("spawn"));
	assert.equal(
		sent[sent.indexOf("--name") + 1], "Summarize the diff please");
});

test("spawn falls back to a generic name for a blank task", async () => {
	publishEndpoint(true);
	const runs = [];
	const { runner } = makeRunner((_file, args) => {
		runs.push(args);
		return Promise.resolve({ stdout: JSON.stringify({
			ok: true, id: "fork-3", session: "teammate",
		}), stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	await agent.spawn("", "", "   ");
	const sent = runs.find((a) => a.includes("spawn"));
	assert.equal(sent[sent.indexOf("--name") + 1], "teammate");
});

test("AgentDirectory resolves local and peer main agents", async () => {
	const directory = new AgentDirectory(async () => [
		{ id: "rog-windows:pi-1", name: "a", role: "main", pid: 1,
			parent: null, session: null, online: true },
		{ id: "beta:pi-2", name: "b", role: "main", pid: 2,
			parent: null, session: null, online: false, origin: "beta" },
	], "rog-windows");
	assert.equal(directory.isLocal(""), true);
	assert.equal(directory.isLocal("rog-windows"), true);
	assert.equal(directory.isLocal("beta"), false);
	assert.equal((await directory.mainAgent("rog-windows")).id,
		"rog-windows:pi-1");
	assert.equal((await directory.mainAgent("beta")).id, "beta:pi-2");
});

test("spawn routes a peer host through the broker op", async () => {
	publishEndpoint(true);
	const runs = [];
	const { calls, runner } = makeRunner((file, args) => {
		runs.push(args);
		return Promise.resolve({ stdout: JSON.stringify({
			ok: true, id: "beta:fork-1", session: "worker",
		}), stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	const ref = await agent.spawn("beta", "worker", "do it");
	assert.equal(ref.id, "beta:fork-1");
	assert.equal(ref.session, "worker");
	const sent = runs.find((a) => a.includes("spawn"));
	assert.ok(sent, "no spawn op was sent to the broker");
	assert.equal(sent[sent.indexOf("--host") + 1], "beta");
	// A peer spawn is still only a broker op: no main-agent relay and
	// no child process of ours.
	assert.equal(calls.length, 1, "peer spawn must not launch a child");
	assert.ok(!runs.some((a) => a.includes("ls")),
		"spawn must not enumerate peer main agents");
	agent.stopHold();
});

test("spawn reports the broker's error", async () => {
	publishEndpoint(true);
	const { runner } = makeRunner(() => Promise.resolve({
		stdout: JSON.stringify({
			ok: false, error: "no-session-host",
			detail: "no host answered on beta",
		}), stderr: "", code: 0,
	}));
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	await assert.rejects(() => agent.spawn("beta", "worker", "do it"),
		(err) => {
			assert.match(err.message, /no-session-host/);
			assert.match(err.message, /no host answered on beta/);
			return true;
		});
	agent.stopHold();
});

test("spawn fails when the broker returns no id", async () => {
	publishEndpoint(true);
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	await assert.rejects(() => agent.spawn("", "worker", "do it"),
		/spawn failed/);
	agent.stopHold();
});

test("spawn starts a detached broker only when none is published", () => {
	publishEndpoint(false);
	const { agent, calls } = makeAgent();
	agent.ensureBroker();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, process.env.PYTHON || "python3");
	assert.deepEqual(calls[0].args, [join(binDir, "teamd"), "--root", stateRoot, "start"]);
	assert.equal(calls[0].options.detached, true);
	assert.equal(calls[0].options.stdio, "ignore");
	assert.equal(calls[0].options.windowsHide, true);
	assert.equal(calls[0].unrefed, true);

	publishEndpoint(true);
	agent.ensureBroker();
	assert.equal(calls.length, 1);
});

test("deregister closes the held connection", () => {
	const { agent, calls } = makeAgent();
	agent.hold("/x");
	agent.deregister();
	assert.equal(calls[0].stdinEnded, true);
	assert.equal(calls[0].killed, true);
});

test("peerAdd asks the broker to own the ssh tunnel", async () => {
	const runs = [];
	const { runner } = makeRunner((_file, args) => {
		runs.push(args);
		return Promise.resolve({ stdout: JSON.stringify({
			op: "ack", label: "hz", host: "hz-server",
		}), stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	const peer = await agent.peerAdd("peer.example", "hz");
	assert.equal(peer.host, "hz-server");
	const add = runs.find((a) => a.includes("peer") && a.includes("add"));
	assert.ok(add, "no broker peer-add was run");
	assert.ok(add.includes("--label"));
	assert.ok(add.includes("hz"));
	assert.ok(add.includes("--ssh"));
	assert.ok(add.includes("peer.example"));
});

test("peerAdd relays the broker's setup guidance on failure", async () => {
	const { runner } = makeRunner(() => Promise.resolve({
		stdout: JSON.stringify({
			op: "error", error: "peer-unreachable",
			detail: "the host needs a password or a different key",
			setup: "sh /opt/pi-teams/peer-ssh-setup 'peer.example'",
		}), stderr: "", code: 0,
	}));
	const agent = new TeamAgent(runner, () => {});
	await assert.rejects(() => agent.peerAdd("peer.example", "hz"),
		(err) => {
			assert.match(err.message, /not usable non-interactively/);
			assert.match(err.message, /peer-ssh-setup/);
			return true;
		});
});

test("peers lists what the broker owns; peerRemove resolves by host", async () => {
	const runs = [];
	const { runner } = makeRunner((_file, args) => {
		runs.push(args);
		if (args.includes("list")) {
			return Promise.resolve({ stdout: JSON.stringify({
				op: "peers", peers: [{ label: "hz", host: "hz-server",
					online: true, ssh: "peer.example" }],
			}), stderr: "", code: 0 });
		}
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	const peers = await agent.peers();
	assert.equal(peers[0].host, "hz-server");
	await agent.peerRemove("hz-server");
	const remove = runs.find((a) =>
		a.includes("peer") && a.includes("remove"));
	assert.ok(remove && remove.includes("hz"));
});

test("ProcessRunner hides every child console", async () => {
	const calls = [];
	const spawnProcess = (file, args, options) => {
		const api = spawnStub(calls, file, args, options);
		const record = calls[calls.length - 1];
		setTimeout(() => {
			record["stdout:data"]?.("out");
			record["stderr:data"]?.("err");
			record["on:close"]?.(0);
		}, 0);
		return api;
	};
	const runner = new ProcessRunner(spawnProcess);
	const result = await runner.run("ssh", ["x"], { timeout: 100 });
	assert.equal(result.stdout, "out");
	assert.equal(result.stderr, "err");
	assert.equal(result.code, 0);
	assert.equal(calls[0].options.windowsHide, true);
	const hidden = runner.spawnHidden("ssh", ["y"]);
	assert.ok(hidden);
	assert.equal(calls[1].options.windowsHide, true);
	assert.equal(calls[1].options.detached, undefined);
	const detached = runner.spawnDetached("ssh", ["z"]);
	assert.ok(detached);
	assert.equal(calls[2].options.windowsHide, true);
	assert.equal(calls[2].options.detached, process.platform !== "win32");
	const persistent = runner.spawnPersistent("pythonw", ["w"]);
	assert.ok(persistent);
	assert.equal(calls[3].options.windowsHide, true);
	assert.equal(calls[3].options.detached, true);
});

test("windowlessCandidates maps Python interpreters to GUI twins", () => {
	assert.ok(windowlessCandidates("C:/py/python.exe")
		.includes("C:/py/pythonw.exe"));
	assert.ok(windowlessCandidates("python3").includes("pythonw3"));
	assert.ok(windowlessCandidates("python").includes("pythonw"));
	assert.ok(windowlessCandidates("py").includes("pyw"));
});

test("WindowlessPython resolves a probed twin only off Windows", () => {
	const probes = [];
	const resolver = new WindowlessPython("python3", (candidate) => {
		probes.push(candidate);
		return candidate === "pythonw3";
	});
	if (process.platform === "win32") {
		assert.equal(resolver.resolve(), "pythonw3");
		assert.deepEqual(probes, ["pythonw3"]);
	} else {
		assert.equal(resolver.resolve(), "python3");
		assert.deepEqual(probes, []);
	}
	const none = new WindowlessPython("python3", () => false);
	assert.equal(none.resolve(), "python3");
});

test("PendingRequests resolves a waiter from its reply", async () => {
	const pending = new PendingRequests();
	const wait = pending.register("r1", 5000);
	pending.settle({
		from: "x", to: "me", kind: "spawn-ack",
		payload: { requestId: "r1", id: "f1", session: "s" },
	}, "spawn-ack");
	assert.deepEqual(await wait, { id: "f1", session: "s" });
});

test("PendingRequests fails a waiter on a non-ack reply", async () => {
	const pending = new PendingRequests();
	const wait = pending.register("r2", 5000);
	pending.settle({
		from: "x", to: "me", kind: "spawn-error",
		payload: { requestId: "r2" },
	}, "spawn-ack");
	assert.equal(await wait, null);
});

test("PendingRequests times out and cancels without leaking", async () => {
	const pending = new PendingRequests();
	assert.equal(await pending.register("r3", 10), null);
	const waiting = pending.register("r4", 5000);
	pending.cancelAll();
	assert.equal(await waiting, null);
	// A later register resolves at once after cancellation.
	assert.equal(await pending.register("r5", 5000), null);
});


test("attachTo re-registers as a fork and notifies the parent", async () => {
	const sends = [];
	const { calls, runner } = makeRunner((file, args) => {
		sends.push(args);
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	const before = agent.id;
	const ref = await agent.attachTo("parent-9", "helper");
	assert.notEqual(agent.id, before);
	assert.ok(agent.id.includes(":fork-"), "id is not a fork id");
	assert.equal(ref.session, "helper");
	// The attach applies the fork identity to this process env, so the
	// attached session's shell tools can run the report command.
	assert.equal(process.env.TEAM_PARENT_ID, "parent-9");
	assert.equal(process.env.TEAM_ROLE, "fork");
	assert.ok(process.env.TEAM_ROOT, "TEAM_ROOT was not applied");
	const hold = calls[calls.length - 1];
	assert.equal(hold.options.env.TEAM_ID, agent.id);
	assert.equal(hold.options.env.TEAM_ROLE, "fork");
	assert.equal(hold.options.env.TEAM_PARENT_ID, "parent-9");
	assert.equal(hold.options.env.TEAM_NAME, "helper");
	const notice = sends.find((a) => a.includes("notice"));
	assert.ok(notice && notice.includes("parent-9"),
		"no attach notice was sent to the parent");
	agent.detach();
	agent.stopHold();
});

test("detach returns an attached agent to a main identity", async () => {
	const { calls, runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	const attached = await agent.attachTo("parent-9", "helper");
	const detached = agent.detach();
	assert.notEqual(detached, attached.id);
	const hold = calls[calls.length - 1];
	assert.equal(hold.options.env.TEAM_ROLE, "main");
	assert.equal(hold.options.env.TEAM_PARENT_ID, "");
	agent.stopHold();
});

test("detach restores the process env attach overwrote", async () => {
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const savedName = process.env.TEAM_NAME;
	process.env.TEAM_NAME = "mine";
	const agent = new TeamAgent(runner, () => {});
	try {
		agent.hold("/work");
		await agent.attachTo("parent-9", "helper");
		agent.detach();
		assert.equal(process.env.TEAM_NAME, "mine");
		assert.equal(process.env.TEAM_PARENT_ID, undefined);
	} finally {
		if (savedName !== undefined) process.env.TEAM_NAME = savedName;
		else delete process.env.TEAM_NAME;
		agent.stopHold();
	}
});

test("an inbound attach request converts this session and acks", async () => {
	// A non-teammate session: clear the spawn identity the suite sets so
	// the agent registers as main and may be attached.
	const savedId = process.env.TEAM_ID;
	delete process.env.TEAM_ID;
	const sends = [];
	const { calls, runner } = makeRunner((file, args) => {
		sends.push(args);
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	if (savedId !== undefined) process.env.TEAM_ID = savedId;
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	onData(JSON.stringify({
		from: "alpha:main", to: agent.id, kind: "attach",
		payload: { requestId: "r1", name: "kid" },
	}) + "\n");
	await new Promise((r) => setTimeout(r, 20));
	const ack = sends.find((a) => a.includes("attach-ack"));
	assert.ok(ack, "no attach-ack was sent");
	assert.ok(ack.includes("alpha:main"));
	const hold = calls[calls.length - 1];
	assert.equal(hold.options.env.TEAM_ROLE, "fork");
	assert.equal(hold.options.env.TEAM_PARENT_ID, "alpha:main");
	agent.detach();
	agent.stopHold();
});

test("attach refuses when this session is already a teammate", async () => {
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const savedParent = process.env.TEAM_PARENT_ID;
	process.env.TEAM_PARENT_ID = "root-1";
	try {
		const agent = new TeamAgent(runner, () => {});
		await assert.rejects(() => agent.attach("beta:main"), /one team/);
	} finally {
		if (savedParent === undefined) delete process.env.TEAM_PARENT_ID;
		else process.env.TEAM_PARENT_ID = savedParent;
	}
});

test("an inbound attach request from a teammate is refused", async () => {
	const sends = [];
	const { calls, runner } = makeRunner((file, args) => {
		if (args.includes("ls")) {
			return Promise.resolve({ stdout: JSON.stringify({ agents: [
				{ id: "alpha:fork-1", name: "f", role: "fork", pid: 1,
				  parent: "alpha:root", session: null, online: true },
			] }), stderr: "", code: 0 });
		}
		sends.push(args);
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	onData(JSON.stringify({
		from: "alpha:fork-1", to: agent.id, kind: "attach",
		payload: { requestId: "r1", name: "kid" },
	}) + "\n");
	await new Promise((r) => setTimeout(r, 20));
	const error = sends.find((a) => a.includes("attach-error"));
	assert.ok(error, "no attach-error was sent");
	assert.ok(error.join(" ").includes("requester-is-teammate"),
		"refusal did not say the requester is a teammate");
	assert.ok(!sends.some((a) => a.includes("attach-ack")),
		"a teammate's attach request was accepted");
	agent.stopHold();
});

test("attach asks a target agent and returns its new fork id", async () => {
	const sends = [];
	const { calls, runner } = makeRunner((file, args) => {
		sends.push(args);
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	const pending = agent.attach("beta:main", "kid");
	await new Promise((r) => setTimeout(r, 20));
	const sent = sends.find((a) => a.includes("attach"));
	assert.ok(sent, "attach request was not sent");
	const request = JSON.parse(sent[sent.length - 1]);
	onData(JSON.stringify({
		from: "beta:main", to: agent.id, kind: "attach-ack",
		payload: { requestId: request.requestId, id: "beta:fork-1",
			session: "kid" },
	}) + "\n");
	const ref = await pending;
	assert.equal(ref.id, "beta:fork-1");
	assert.equal(ref.session, "kid");
	agent.stopHold();
});

test("deregister resolves a pending attach instead of hanging it", async () => {
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	const pending = agent.attach("beta:main", "kid");
	agent.deregister();
	const ref = await pending;
	assert.equal(ref, null);
});

test("member-only operations refuse a non-team session", async () => {
	const savedId = process.env.TEAM_ID;
	delete process.env.TEAM_ID;
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, () => {});
	if (savedId !== undefined) process.env.TEAM_ID = savedId;
	assert.equal(await agent.isTeammate(), false);
	await assert.rejects(() => agent.requireTeammate("team_send"),
		/team member/);
	await assert.rejects(() => agent.requireTeammate("team_wait"),
		/team member/);
});

test("attaching makes a session a teammate that passes the gate", async () => {
	const savedId = process.env.TEAM_ID;
	delete process.env.TEAM_ID;
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, () => {});
	if (savedId !== undefined) process.env.TEAM_ID = savedId;
	agent.hold("/work");
	assert.equal(await agent.isTeammate(), false);
	await agent.attachTo("parent-9", "helper");
	assert.equal(await agent.isTeammate(), true);
	await assert.doesNotReject(() => agent.requireTeammate("team_send"));
	agent.detach();
	assert.equal(await agent.isTeammate(), false);
	agent.stopHold();
});

test("spawning makes the spawner a teammate", async () => {
	const savedId = process.env.TEAM_ID;
	delete process.env.TEAM_ID;
	const { runner } = makeRunner((file, args) => {
		if (args.includes("spawn")) {
			return Promise.resolve({ stdout: JSON.stringify({
				ok: true, id: "kid-fork", session: "kid",
			}), stderr: "", code: 0 });
		}
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	if (savedId !== undefined) process.env.TEAM_ID = savedId;
	agent.hold("/work");
	// The empty snapshot means only the spawn itself can grant membership.
	assert.equal(await agent.isTeammate(), false);
	const ref = await agent.spawn("", "kid", "do it");
	assert.equal(ref.id, "kid-fork");
	assert.equal(await agent.isTeammate(), true);
	await assert.doesNotReject(() => agent.requireTeammate("team_send"));
	agent.stopHold();
});

test("owning a registered teammate grants membership after reload", async () => {
	const savedId = process.env.TEAM_ID;
	delete process.env.TEAM_ID;
	const holder = {};
	const { runner } = makeRunner((file, args) => {
		if (args.includes("ls")) {
			return Promise.resolve({ stdout: JSON.stringify({ agents: [{
				id: "x", name: "x", role: "fork", pid: 1,
				parent: holder.agent.id, session: null, online: true,
			}] }), stderr: "", code: 0 });
		}
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	holder.agent = new TeamAgent(runner, () => {});
	if (savedId !== undefined) process.env.TEAM_ID = savedId;
	assert.equal(await holder.agent.isTeammate(), true);
});

test("main identity derives from the session stem", () => {
	const savedId = process.env.TEAM_ID;
	delete process.env.TEAM_ID;
	const agent = new TeamAgent(makeRunner().runner, () => {});
	try {
	assert.equal(agent.identitySuffix(), "");
	agent.rememberSession(join(sessionDir,
		"2026-09-23T03-29-41-877Z_01a0cc4f-dff4.jsonl"));
	// The suffix keeps the session stem's safe characters, capped at 32.
	assert.equal(agent.identitySuffix(), "2026-09-23T03-29-41-877Z-01a0cc4");
	assert.equal(agent.registryName(),
		"2026-09-23T03-29-41-877Z_01a0cc4f-dff4");
	// A session-stem id is stable across re-holds; a random one minted
	// a fresh registry identity per process load.
	assert.equal(agent.ensureId(), agent.ensureId());
	assert.ok(agent.id.startsWith(`${agent.host}:pi-`));
	} finally {
		if (savedId !== undefined) process.env.TEAM_ID = savedId;
	}
});

test("reload handover keeps identity and surrenders the old hold", () => {
	const first = new TeamAgent(makeRunner().runner, () => {});
	first.id = "rog:pi-1-stem";
	first.sendToken = "st-handover";
	const second = new TeamAgent(makeRunner().runner, () => {});
	second.inheritIdentity(first);
	assert.equal(second.id, "rog:pi-1-stem");
	assert.equal(second.sendToken, "st-handover");
	first.handover();
	assert.equal(first.surrendered, true);
});

test("reap acks the broker with this agent's identity and token", async () => {
	const runs = [];
	const { runner } = makeRunner((file, args) => {
		runs.push({ file, args });
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	agent.id = "rog:pi-1-stem";
	await agent.reap();
	const call = runs.find((c) => c.args.includes("reap"));
	assert.ok(call, "no reap op was sent");
	assert.equal(call.args[call.args.indexOf("--id") + 1], "rog:pi-1-stem");
	assert.equal(call.args[call.args.indexOf("--send-token") + 1],
		agent.sendToken);
});


test("settings read the piTeams object, env overriding the file", () => {
	const dir = mkdtempSync(join(scratch, "settings-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({
		piTeams: {
			host: "file-host",
			gcIdleHours: 111,
			busyGraceHours: 222,
			stallSeconds: 0,
			sessionsRoot: join(dir, "file-sessions"),
			ssh: "file-ssh",
		},
		other: { ignored: true },
	}));
	const file = new PackageSettings({}, dir);
	assert.equal(file.host(), "file-host");
	assert.equal(file.gcIdleHours(), 111);
	assert.equal(file.busyGraceHours(), 222);
	assert.equal(file.stallSeconds(), 0);
	assert.equal(file.sessionsRoot(), join(dir, "file-sessions"));
	assert.equal(file.ssh(), "file-ssh");

	// An explicit non-empty env variable beats the settings value.
	const env = new PackageSettings({
		PI_TEAMS_HOST: "env-host",
		PI_TEAMS_GC_IDLE_HOURS: "5",
		PI_TEAMS_STALL: "0",
	}, dir);
	assert.equal(env.host(), "env-host");
	assert.equal(env.gcIdleHours(), 5);
	assert.equal(env.stallSeconds(), 0);
});

test("settings fall back to built-in defaults without a file", () => {
	const s = new PackageSettings({}, join(scratch, "no-settings"));
	assert.equal(s.gcIdleHours(), 3);
	assert.equal(s.busyGraceHours(), 2);
	assert.equal(s.restartGraceSeconds(), 60);
	assert.equal(s.peerGraceSeconds(), 15);
	assert.equal(s.sessionGraceHours(), 72);
	assert.equal(s.sessionSweepIntervalSeconds(), 3600);
	assert.equal(s.spawnWindowMs(), 15000);
	assert.equal(s.waitSeconds(), 300);
	assert.equal(s.stallSeconds(), 90);
	assert.equal(s.ssh(), "ssh");
	assert.equal(s.remoteState(), null);
	assert.equal(s.peerSetup(), null);
	assert.equal(s.stateDir(),
		join(homedir(), ".local", "state", "pi-teams"));
	assert.equal(s.sessionsRoot(), join(scratch, "no-settings", "sessions"));
});

test("a missing, malformed, or non-object settings file is tolerated", () => {
	const dir = mkdtempSync(join(scratch, "bad-settings-"));
	// Missing file: the constructed agent dir simply has none.
	assert.equal(new PackageSettings({}, dir).gcIdleHours(), 3);
	// Malformed JSON.
	writeFileSync(join(dir, "settings.json"), "{not json");
	assert.equal(new PackageSettings({}, dir).gcIdleHours(), 3);
	// piTeams exists but is not an object.
	writeFileSync(join(dir, "settings.json"),
		JSON.stringify({ piTeams: ["nope"] }));
	assert.equal(new PackageSettings({}, dir).gcIdleHours(), 3);
});

test("negative and invalid numbers fall through to the default", () => {
	const dir = mkdtempSync(join(scratch, "invalid-settings-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({
		piTeams: { gcIdleHours: -1, busyGraceHours: "nope" },
	}));
	const file = new PackageSettings({}, dir);
	assert.equal(file.gcIdleHours(), 3);
	assert.equal(file.busyGraceHours(), 2);
	assert.equal(new PackageSettings({ PI_TEAMS_GC_IDLE_HOURS: "abc" }, dir)
		.gcIdleHours(), 3);
});

test("gc idle reads hours and treats zero as a real value", () => {
	const dir = join(scratch, "gc-settings");
	assert.equal(new PackageSettings({}, dir).gcIdleHours(), 3);
	assert.equal(new PackageSettings({ PI_TEAMS_GC_IDLE_HOURS: "8" }, dir)
		.gcIdleHours(), 8);
	assert.equal(new PackageSettings({ PI_TEAMS_GC_IDLE_HOURS: "0" }, dir)
		.gcIdleHours(), 0);
});

test("isConfigured distinguishes a default from a configured value", () => {
	const dir = join(scratch, "configured-settings");
	assert.equal(
		new PackageSettings({}, dir).isConfigured("PI_TEAMS_BIN", "binDir"),
		false);
	assert.equal(
		new PackageSettings({ PI_TEAMS_BIN: "/x" }, dir)
			.isConfigured("PI_TEAMS_BIN", "binDir"),
		true);
	const withFile = mkdtempSync(join(scratch, "file-bin-"));
	writeFileSync(join(withFile, "settings.json"),
		JSON.stringify({ piTeams: { binDir: "/file/bin" } }));
	assert.equal(
		new PackageSettings({}, withFile)
			.isConfigured("PI_TEAMS_BIN", "binDir"),
		true);
});

test("sessionsRoot keeps the legacy PI_SESSIONS_ROOT fallback", () => {
	const dir = join(scratch, "session-root-settings");
	assert.equal(
		new PackageSettings({ PI_SESSIONS_ROOT: "/legacy" }, dir)
			.sessionsRoot(),
		"/legacy");
	assert.equal(new PackageSettings({
		PI_TEAMS_SESSIONS_ROOT: "/new",
		PI_SESSIONS_ROOT: "/legacy",
	}, dir).sessionsRoot(), "/new");
});


// -- /team-settings --------------------------------------------------

const ROW_ORDER = "spawnWindowMs,waitSeconds,stallSeconds,binDir,ssh," +
	"remoteState,sessionsRoot,host,stateDir,gcIdleHours," +
	"busyGraceHours,restartGraceSeconds," +
	"peerGraceSeconds,sessionGraceHours," +
	"sessionSweepIntervalSeconds,peerSetup,restoreDefaults";

const VIEW_THEME = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/** A ui stub: records notifications and captures the custom view the
 *  presenter builds, without a terminal. */
function recordingUi() {
	const notes = [];
	let view;
	let calls = 0;
	const ui = {
		notify: (message, type) => notes.push({ message, type }),
		custom: async (factory) => {
			calls += 1;
			view = factory({ requestRender: () => {} }, VIEW_THEME, {}, () => {});
			return undefined;
		},
	};
	return { ui, notes, view: () => view, calls: () => calls };
}

test("team-settings rows keep the piTeams order and effective values", () => {
	const dir = join(scratch, "settings-rows");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify({
		piTeams: { waitSeconds: 42, ssh: "custom-ssh" },
	}));
	const settings = new PackageSettings({}, dir);
	const presenter = new TeamSettingsPresenter(settings, new SettingsStore(), {});
	const rows = presenter.rows();
	assert.equal(rows.map((row) => row.id).join(","), ROW_ORDER);
	assert.equal(rows.length, 17);
	assert.equal(rows[1].value, "42");
	assert.equal(rows[4].value, "custom-ssh");
	assert.equal(rows[1].title, "Wait timeout");
	assert.equal(rows[15].value, "");
	for (const row of rows) {
		assert.equal(typeof row.submenu, "function");
	}
});

test("team-settings marks an env-pinned row and lists rows off-TUI", async () => {
	const dir = join(scratch, "settings-pinned");
	const env = { PI_TEAMS_WAIT: "5" };
	const presenter = new TeamSettingsPresenter(
		new PackageSettings(env, dir), new SettingsStore(), env);
	const rows = presenter.rows();
	assert.equal(rows[1].value, "5");
	assert.equal(rows[1].title, "Wait timeout (env-pinned)");
	assert.equal(rows[0].title, "Spawn window");

	let printed = "";
	const original = console.error;
	console.error = (line) => { printed += String(line); };
	let customCalls = 0;
	try {
		await presenter.present(
			{ custom: () => { customCalls += 1; } },
			"print",
			() => { throw new Error("no change expected"); });
	} finally {
		console.error = original;
	}
	assert.equal(customCalls, 0, "non-TUI modes never open the view");
	assert.match(printed, /pi-teams-settings:/);
	assert.match(printed, /Spawn window: .*current: 15000/);
	assert.match(printed, /Peer setup command: .*current: \(empty\)/);
});

test("team-settings opens the custom view and renders every row", async () => {
	const dir = join(scratch, "settings-tui");
	const presenter = new TeamSettingsPresenter(
		new PackageSettings({}, dir), new SettingsStore(), {});
	const recorder = recordingUi();
	await presenter.present(recorder.ui, "tui", () => {});
	assert.equal(recorder.calls(), 1);
	const view = recorder.view();
	assert.ok(view instanceof TeamSettingsView);
	const lines = view.render(120).join("\n");
	assert.match(lines, /Spawn window/);
	assert.match(lines, /Wait timeout/);
	assert.match(lines, /Peer setup command/);
});

// chmod on Windows only toggles the read-only bit, so the exact POSIX
// mode bits cannot be observed there; assert the meaningful property
// instead, that the file is still writable by its owner.
function assertSettingsMode(file) {
	if (process.platform === "win32") {
		assert.notEqual(statSync(file).mode & 0o200, 0);
	} else {
		assert.equal(statSync(file).mode & 0o777, 0o640);
	}
}

test("team-settings writes piTeams atomically, keeping keys and mode", () => {
	const dir = mkdtempSync(join(scratch, "settings-store-"));
	const file = join(dir, "settings.json");
	writeFileSync(file, JSON.stringify({
		theme: "dark",
		packages: ["git:x"],
		piTeams: { ssh: "old-ssh" },
	}, null, 2) + "\n");
	chmodSync(file, 0o640);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const presenter = new TeamSettingsPresenter(
			new PackageSettings({}, dir), new SettingsStore(), {});
		const recorder = recordingUi();
		presenter.apply("waitSeconds", "42", recorder.ui);
		const saved = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(saved.piTeams.waitSeconds, 42);
		assert.equal(saved.piTeams.ssh, "old-ssh");
		assert.equal(saved.theme, "dark");
		assert.deepEqual(saved.packages, ["git:x"]);
		assertSettingsMode(file);
		assert.deepEqual(
			readdirSync(dir).filter((name) => name.startsWith("settings.json.tmp")),
			[]);
		assert.match(recorder.notes.at(-1).message, /^Saved Wait timeout\./);
		assert.equal(recorder.notes.at(-1).type, "info");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("team-settings refuses a corrupt file and rejects bad numbers", () => {
	const dir = mkdtempSync(join(scratch, "settings-corrupt-"));
	const file = join(dir, "settings.json");
	writeFileSync(file, "{not json");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const presenter = new TeamSettingsPresenter(
			new PackageSettings({}, dir), new SettingsStore(), {});
		const recorder = recordingUi();
		presenter.apply("waitSeconds", "42", recorder.ui);
		assert.equal(readFileSync(file, "utf8"), "{not json");
		assert.equal(recorder.notes.at(-1).type, "error");
		assert.match(recorder.notes.at(-1).message, /Could not save Wait timeout/);

		const clean = mkdtempSync(join(scratch, "settings-invalid-"));
		process.env.PI_CODING_AGENT_DIR = clean;
		const strict = new TeamSettingsPresenter(
			new PackageSettings({}, clean), new SettingsStore(), {});
		const notes = recordingUi();
		strict.apply("waitSeconds", "not-a-number", notes.ui);
		assert.equal(notes.notes.at(-1).type, "error");
		assert.match(notes.notes.at(-1).message, /number at or above 0/);
		assert.equal(existsSync(join(clean, "settings.json")), false);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("SettingsStore.reset drops only the piTeams namespace", () => {
	const dir = mkdtempSync(join(scratch, "settings-reset-"));
	const file = join(dir, "settings.json");
	writeFileSync(file, JSON.stringify({
		theme: "dark",
		packages: ["git:x"],
		piTeams: { ssh: "old-ssh", waitSeconds: 42 },
	}, null, 2) + "\n");
	chmodSync(file, 0o640);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		new SettingsStore().reset();
		const saved = JSON.parse(readFileSync(file, "utf8"));
		assert.equal("piTeams" in saved, false);
		assert.equal(saved.theme, "dark");
		assert.deepEqual(saved.packages, ["git:x"]);
		assertSettingsMode(file);
		assert.deepEqual(
			readdirSync(dir).filter(
				(name) => name.startsWith("settings.json.tmp")),
			[]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("team-settings exposes restoreDefaults and clears the namespace", () => {
	const dir = mkdtempSync(join(scratch, "settings-restore-"));
	const file = join(dir, "settings.json");
	writeFileSync(file, JSON.stringify({
		theme: "dark", piTeams: { ssh: "old-ssh" },
	}, null, 2) + "\n");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const presenter = new TeamSettingsPresenter(
			new PackageSettings({}, dir), new SettingsStore(), {});
		const row = presenter.rows().at(-1);
		assert.equal(row.id, "restoreDefaults");
		assert.equal(row.title, "Restore default configuration");
		assert.equal(row.value, "");
		assert.equal(typeof row.submenu, "function");

		const recorder = recordingUi();
		const result = presenter.restoreDefaults(recorder.ui);
		assert.match(result, /Restored default configuration/);
		assert.equal(recorder.notes.at(-1).type, "info");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		assert.equal("piTeams" in saved, false);
		assert.equal(saved.theme, "dark");

		// A corrupt file is reported, never overwritten.
		writeFileSync(file, "{not json");
		const failure = presenter.restoreDefaults(recorder.ui);
		assert.match(failure, /Could not restore defaults/);
		assert.equal(recorder.notes.at(-1).type, "error");
		assert.equal(readFileSync(file, "utf8"), "{not json");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});



test("team_wait returns a delivered report as formatted text", async () => {
	// Regression: the report path called formatReport without importing
	// it, so a real report threw "formatReport is not defined".
	const tools = new Map();
	const pi = {
		appendEntry: () => {},
		sendMessage: () => {},
		on: () => {},
		registerEntryRenderer: () => {},
		registerCommand: () => {},
		registerTool: (definition) => tools.set(definition.name, definition),
	};
	const previous = globalThis.__piTeamsAgent;
	globalThis.__piTeamsAgent = undefined;
	try {
		const { default: register } =
			await import("../extensions/pi-teams.ts");
		await register(pi);
		const app = globalThis.__piTeamsAgent;
		assert.ok(app, "the extension publishes its agent");
		const report = {
			from: "kid", to: app.id, kind: "result", payload: "all done",
		};
		app.requireTeammate = async () => {};
		app.setState = () => {};
		app.setBusy = () => {};
		app.waitForResults = async () => ({
			results: [report], interruptedBy: null,
		});
		const result = await tools.get("team_wait").execute(
			"call-1", { id: "kid" }, undefined, undefined,
			{ hasPendingMessages: () => false });
		assert.equal(result.content[0].text, formatReport(report));
		assert.equal(result.details.reports[0].payload, "all done");
		assert.deepEqual(result.details.remaining, []);
	} finally {
		if (previous === undefined) delete globalThis.__piTeamsAgent;
		else globalThis.__piTeamsAgent = previous;
	}
});

test("team_wait reports a message that woke the wait", async () => {
	const tools = new Map();
	const pi = {
		appendEntry: () => {},
		sendMessage: () => {},
		on: () => {},
		registerEntryRenderer: () => {},
		registerCommand: () => {},
		registerTool: (definition) => tools.set(definition.name, definition),
	};
	const previous = globalThis.__piTeamsAgent;
	globalThis.__piTeamsAgent = undefined;
	try {
		const { default: register } =
			await import("../extensions/pi-teams.ts");
		await register(pi);
		const app = globalThis.__piTeamsAgent;
		assert.ok(app, "the extension publishes its agent");
		const message = {
			from: "kid", to: app.id, kind: "text", payload: "need input",
		};
		app.requireTeammate = async () => {};
		app.setState = () => {};
		app.setBusy = () => {};
		app.waitForResults = async () => ({
			results: [null], interruptedBy: message,
		});
		const result = await tools.get("team_wait").execute(
			"call-1", { id: "kid" }, undefined, undefined,
			{ hasPendingMessages: () => false });
		assert.match(result.content[0].text, /yielded to a text from kid/);
		assert.equal(result.details.interruptedBy.payload, "need input");
		assert.deepEqual(result.details.remaining, ["kid"]);
	} finally {
		if (previous === undefined) delete globalThis.__piTeamsAgent;
		else globalThis.__piTeamsAgent = previous;
	}
});

test("the extension wires team_gc_reap to ack and shut down", async () => {
	// The tool answers the broker's idle request: ack the reap through
	// the broker, then request an orderly process shutdown.
	const tools = new Map();
	const pi = {
		appendEntry: () => {},
		sendMessage: () => {},
		on: () => {},
		registerEntryRenderer: () => {},
		registerCommand: () => {},
		registerTool: (definition) => tools.set(definition.name, definition),
	};
	const previous = globalThis.__piTeamsAgent;
	globalThis.__piTeamsAgent = undefined;
	try {
		const { default: register } =
			await import("../extensions/pi-teams.ts");
		await register(pi);
		const app = globalThis.__piTeamsAgent;
		assert.ok(app, "the extension publishes its agent");
		let reaped = 0;
		let shut = 0;
		app.reap = async () => { reaped += 1; };
		const result = await tools.get("team_gc_reap").execute(
			"call-1", {}, undefined, undefined,
			{ shutdown: () => { shut += 1; } });
		assert.equal(reaped, 1, "the reap was not acked to the broker");
		assert.equal(shut, 1, "the session shutdown was not requested");
		assert.match(result.content[0].text, /reaping this session/);
	} finally {
		if (previous === undefined) delete globalThis.__piTeamsAgent;
		else globalThis.__piTeamsAgent = previous;
	}
});

/** A minimal ExtensionAPI double for driving PreTeamsTool. */
function makeOnboardingPi() {
	const handlers = new Map();
	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(definition) {
			pi.tool = definition;
		},
		async emit(name, event, ctx) {
			const results = [];
			for (const handler of handlers.get(name) ?? []) {
				results.push(await handler(event, ctx));
			}
			return results;
		},
	};
	return pi;
}

test("pre_teams catalog covers every team tool, conventions, features", async () => {
	const pi = makeOnboardingPi();
	new PreTeamsTool().register(pi);
	assert.equal(pi.tool.name, "pre_teams");
	const result = await pi.tool.execute("call-1", {}, undefined, undefined,
		{});
	const text = result.content[0].text;
	assert.match(text, /Conventions:/);
	assert.match(text, /Features:/);
	assert.match(text, /pre_teams/);
	const names = [
		"team_spawn", "team_attach", "team_wait", "team_send",
		"team_ls", "team_tail", "team_peer", "team_detach",
		"team_kill", "team_gc_reap",
	];
	assert.deepEqual(result.details.tools, names);
	for (const name of names) {
		assert.match(text, new RegExp(`- ${name}: `),
			`${name} has a one-line purpose in the catalog`);
	}
});

test("pre_teams gate blocks its own tools only, until acknowledged", async () => {
	const pi = makeOnboardingPi();
	new PreTeamsTool().register(pi);

	const [blocked] = await pi.emit("tool_call", { toolName: "team_spawn" });
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /pre_teams/);

	const [foreign] = await pi.emit("tool_call", { toolName: "read" });
	assert.equal(foreign, undefined);

	await pi.emit("tool_call", { toolName: "pre_teams" });
	const [allowed] = await pi.emit("tool_call", { toolName: "team_spawn" });
	assert.equal(allowed, undefined);
});

test("pre_teams session_start resets the gate", async () => {
	const pi = makeOnboardingPi();
	new PreTeamsTool().register(pi);
	await pi.emit("tool_call", { toolName: "pre_teams" });

	await pi.emit("session_start", { reason: "new" });

	const [blocked] = await pi.emit("tool_call", { toolName: "team_wait" });
	assert.equal(blocked.block, true);
});

test("pre_teams defines no custom renderer, so pi collapses natively", () => {
	const pi = makeOnboardingPi();
	new PreTeamsTool().register(pi);
	assert.equal(pi.tool.renderResult, undefined);
	assert.equal(pi.tool.renderCall, undefined);
});
