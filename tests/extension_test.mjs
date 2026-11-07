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
 *   - every registered session is addressable: no membership gate and
 *     no attachment, so team_send reaches any id, local or peer.
 *
 * Runs on Node's built-in test runner; the extension is imported with
 * Node's TypeScript stripping. No broker or pi process is started.
 */

import assert from "node:assert/strict";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
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

const { TeamAgent, ProcessRunner, BrokerOps,
	WindowlessPython, windowlessCandidates, logTeamMessage, AgentDirectory,
	ResultInbox, ChatPeek, ChatEntryRenderer, TranscriptTail, TeamWaitFeed,
	TeamWaitStream, TeamWaitView } =
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
const { TeamsRemoteGuard } =
	await import("../extensions/pi-teams/remote-guard.ts");
const { RemoteWorkClassifier } =
	await import("../extensions/pi-teams/remote-work-classifier.ts");
const { persistPiInvocation, piEntryFile } =
	await import("../extensions/pi-teams/paths.ts");
const { openTeammatesDock } =
	await import("../extensions/pi-teams/dock.ts");

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

test("an obsolete attach request is refused, its replies consumed",
	async () => {
		const runs = [];
		const delivered = [];
		const { runner } = makeRunner((_file, args) => {
			runs.push(args);
			return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
		});
		const agent = new TeamAgent(runner, (m) => delivered.push(m));
		agent.deliverMessage(JSON.stringify({
			op: "message", id: "a1", from: "alpha:main", to: "parent-1",
			kind: "attach",
			payload: JSON.stringify({ requestId: "attach-1", name: "x" }),
			ts: 1,
		}));
		await new Promise((resolve) => setImmediate(resolve));
		// Every registered session is reachable, so there is nothing to
		// attach; the request id rides back so the old sender can settle.
		const reply = runs.find((args) => args.includes("attach-error"));
		assert.ok(reply, "an attach request was not answered");
		assert.ok(reply.some((arg) => arg.includes("attach-1")),
			"the request id was not echoed");
		assert.equal(agent.id, "parent-1", "the request changed the id");
		// A reply from an old sender is control traffic, not a task.
		agent.deliverMessage(JSON.stringify({
			op: "message", id: "a2", from: "alpha:main", to: "parent-1",
			kind: "attach-ack",
			payload: JSON.stringify({ requestId: "attach-2", id: "fork-1" }),
			ts: 2,
		}));
		assert.equal(delivered.length, 0,
			"attach traffic reached the agent");
	});

test("terminate reports a broker refusal", async () => {
	const { runner } = makeRunner(() => Promise.resolve({
		stdout: JSON.stringify({
			op: "error", error: "not-a-fork",
			detail: "beta:main is not a spawned fork",
		}),
		stderr: "", code: 0,
	}));
	await assert.rejects(
		() => new BrokerOps(runner, "python3").terminate("me", "beta:main", "st-1"),
		/not-a-fork: beta:main is not a spawned fork/);
});

test("terminate refuses to report success without an ack", async () => {
	// A crashed or timed-out launch resolves with code 1 and no ack; a
	// malformed reply parses to {}. Neither may read as a termination.
	const failed = makeRunner(() => Promise.resolve({
		stdout: "", stderr: "python3: not found", code: 1,
	}));
	await assert.rejects(
		() => new BrokerOps(failed.runner, "python3").terminate("me", "fork-1"),
		/terminate failed: python3: not found/);
	const silent = makeRunner(() => Promise.resolve({
		stdout: "{}\n", stderr: "", code: 0,
	}));
	await assert.rejects(
		() => new BrokerOps(silent.runner, "python3").terminate("me", "fork-1"),
		/terminate failed: exit 0/);
});

test("terminate presents its sender and accepts the ack", async () => {
	const runCalls = [];
	const { runner } = makeRunner((_file, args) => {
		runCalls.push(args);
		return Promise.resolve({
			stdout: JSON.stringify({ op: "ack" }), stderr: "", code: 0,
		});
	});
	await new BrokerOps(runner, "python3").terminate("me", "fork-9", "st-9");
	const argv = runCalls[0];
	assert.equal(argv[argv.indexOf("--id") + 1], "me");
	assert.equal(argv[argv.indexOf("--send-token") + 1], "st-9");
	assert.equal(argv[argv.length - 1], "fork-9");
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
	"peerGraceSeconds,peerSetup,restoreDefaults";

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
	assert.equal(rows.length, 15);
	assert.equal(rows[1].value, "42");
	assert.equal(rows[4].value, "custom-ssh");
	assert.equal(rows[1].title, "Wait timeout");
	assert.equal(rows[13].value, "");
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

/** Registers the extension against a stub pi and publishes its agent, so
 *  a tool can be executed the way pi executes it. */
async function registerTools() {
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
	const { default: register } = await import("../extensions/pi-teams.ts");
	await register(pi);
	return {
		tools,
		app: globalThis.__piTeamsAgent,
		restore: () => {
			if (previous === undefined) delete globalThis.__piTeamsAgent;
			else globalThis.__piTeamsAgent = previous;
		},
	};
}

test("team_send reaches an unrelated session", async () => {
	// No membership gate stands between a plain main and any registered
	// id: the tool hands the target, kind, and text to the agent.
	const { tools, app, restore } = await registerTools();
	try {
		const sent = [];
		app.send = async (to, kind, text) => {
			sent.push({ to, kind, text });
			return "ack";
		};
		const result = await tools.get("team_send").execute("call-1",
			{ to: "outsider", text: "hi" }, undefined, undefined,
			{ hasPendingMessages: () => false });
		assert.deepEqual(sent, [{ to: "outsider", kind: "text", text: "hi" }]);
		assert.match(result.content[0].text, /sent text to outsider: ack/);
		assert.equal(result.details.reply, "ack");
	} finally {
		restore();
	}
});

test("team_kill surfaces the broker's refusal instead of success", async () => {
	const { tools, app, restore } = await registerTools();
	try {
		app.terminate = async () => {
			throw new Error("not-a-fork: beta:main is not a spawned fork");
		};
		await assert.rejects(
			() => tools.get("team_kill").execute("call-1",
				{ target: "beta:main" }, undefined, undefined,
				{ hasPendingMessages: () => false }),
			/not-a-fork/);
	} finally {
		restore();
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
		"team_spawn", "team_wait", "team_send", "team_ls",
		"team_peek", "team_peer", "team_kill", "team_gc_reap",
	];
	assert.deepEqual(result.details.tools, names);
	const conventions = result.details.conventions.join("\n");
	assert.match(conventions, /team_ls.*team_peek.*team_send/s);
	assert.match(conventions, /route incoming work separately.*team_spawn.*team_wait/is);
	assert.match(conventions, /separate deliverable.*An explicit replacement/is);
	assert.match(conventions, /result destination.*owning session id/is);
	assert.doesNotMatch(conventions, /team_attach|team_detach/);
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

/** A fixture transcript writer for the ChatPeek tests. */
function writeTranscript(name, entries) {
	const path = join(sessionDir, name);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(path,
		entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return path;
}

/** The default peek query, overridden per test. */
function peekQuery(overrides = {}) {
	return {
		from: "tail", limit: 20, offset: 0, grep: null, context: 0,
		include: new Set(ChatPeek.DEFAULT_KINDS), maxChars: 1500,
		...overrides,
	};
}

/** One fixture transcript: a session header, a user turn, an
 *  assistant turn with reasoning, a tool result, and a tool call. */
function peekFixture(name) {
	return writeTranscript(name, [
		{ type: "session", cwd: "/work" },
		{ type: "message", message: { role: "user",
			content: [{ type: "text", text: "hello there" }] } },
		{ type: "message", message: { role: "assistant", content: [
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "hi back" },
		] } },
		{ type: "message", message: { role: "toolResult",
			toolName: "bash", isError: false,
			content: [{ type: "text", text: "tool output" }] } },
		{ type: "message", message: { role: "assistant",
			content: [{ type: "toolCall", name: "bash",
				arguments: { command: "ls" } }] } },
	]);
}

test("ChatPeek renders head and tail pages with the session cwd", async () => {
	const peek = new ChatPeek(peekFixture("peek-basic.jsonl"));
	const query = peekQuery();
	const page = await peek.read(query);
	assert.equal(page.cwd, "/work");
	assert.equal(page.scanned, 5);
	// user, assistant (reasoning + text), assistant (tool call): the
	// tool result and the session header are not default kinds.
	assert.equal(page.units, 3);
	const text = peek.format(page, query, "self");
	assert.match(text, /team_peek self: .*peek-basic\.jsonl/);
	assert.match(text, /cwd \/work/);
	assert.match(text, /#2 user: hello there/);
	assert.match(text, /#3 assistant: hi back/);
	assert.match(text, /#5 assistant: \[call bash/);
	assert.doesNotMatch(text, /tool output/);
	assert.doesNotMatch(text, /hmm/);

	const tailQuery = peekQuery({ limit: 1 });
	const tail = await peek.read(tailQuery);
	assert.equal(tail.page.length, 1);
	assert.match(peek.format(tail, tailQuery, "self"), /#5 assistant/);
});

test("ChatPeek include selects tool and reasoning entries", async () => {
	const peek = new ChatPeek(peekFixture("peek-include.jsonl"));
	const query = peekQuery({
		include: new Set(["user", "assistant", "thinking", "tool"]),
	});
	const page = await peek.read(query);
	assert.equal(page.units, 4);
	const text = peek.format(page, query, "self");
	assert.match(text, /\[thinking\] hmm/);
	assert.match(text, /#4 tool bash: tool output/);
});

test("ChatPeek greps case-insensitively and falls back to a literal",
	async () => {
	const peek = new ChatPeek(writeTranscript("peek-grep.jsonl", [
		{ type: "message", message: { role: "user", content: "Alpha topic" } },
		{ type: "message", message: { role: "assistant", content: "beta" } },
		{ type: "message", message: { role: "user", content: "gamma ALPHA again" } },
		{ type: "message", message: { role: "user", content: "weird foo( token" } },
	]));
	const query = peekQuery({ grep: ChatPeek.pattern("alpha"), context: 1 });
	const page = await peek.read(query);
	assert.equal(page.units, 2);
	const text = peek.format(page, query, "x");
	assert.match(text, /#1 user: Alpha topic/);
	assert.match(text, /#2 assistant: beta/);
	assert.match(text, /#3 user: gamma ALPHA again/);

	// An invalid regex is matched literally instead of throwing.
	const literal = peekQuery({ grep: ChatPeek.pattern("foo(") });
	const literalPage = await peek.read(literal);
	assert.equal(literalPage.units, 1);
	assert.match(peek.format(literalPage, literal, "x"),
		/weird foo\( token/);
});

test("ChatPeek separates non-contiguous grep context with a rule",
	async () => {
	const peek = new ChatPeek(writeTranscript("peek-context.jsonl", [
		{ type: "message", message: { role: "user", content: "hit one" } },
		{ type: "message", message: { role: "assistant", content: "near one" } },
		{ type: "message", message: { role: "user", content: "unrelated" } },
		{ type: "message", message: { role: "assistant", content: "near two" } },
		{ type: "message", message: { role: "user", content: "hit two" } },
	]));
	const query = peekQuery({ grep: ChatPeek.pattern("hit"), context: 1 });
	const text = peek.format(await peek.read(query), query, "x");
	assert.match(text, /#1 user: hit one/);
	assert.match(text, /--/);
	assert.match(text, /#5 user: hit two/);
	assert.doesNotMatch(text, /unrelated/);
});

test("ChatPeek refuses a missing or non-transcript file", async () => {
	await assert.rejects(
		() => new ChatPeek(join(sessionDir, "nope.jsonl")).read(peekQuery()),
		/no longer exists/);
	await assert.rejects(
		() => new ChatPeek(join(sessionDir, "notes.txt")).read(peekQuery()),
		/not a pi transcript/);
});

test("ChatPeek renders a malformed line as unparsed meta", async () => {
	const path = join(sessionDir, "peek-bad.jsonl");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(path, "not json\n" + JSON.stringify(
		{ type: "message", message: { role: "user", content: "ok" } }) +
		"\n");
	const peek = new ChatPeek(path);
	const query = peekQuery({ include: new Set(["meta", "user"]) });
	const page = await peek.read(query);
	assert.equal(page.units, 2);
	assert.match(peek.format(page, query, "x"), /#1 unparsed: not json/);
});

test("ChatPeek caps output and notes the dropped rows", async () => {
	const entries = [{ type: "message", message: { role: "user",
		content: "x".repeat(8000) } }];
	for (let i = 0; i < 30; i += 1) {
		entries.push({ type: "message", message: { role: "assistant",
			content: "y".repeat(8000) } });
	}
	const peek = new ChatPeek(writeTranscript("peek-cap.jsonl", entries));
	const query = peekQuery({ limit: 30, maxChars: 8000 });
	const text = peek.format(await peek.read(query), query, "x");
	assert.ok(text.length < ChatPeek.OUTPUT_CAP + 1000,
		`output stayed bounded, got ${text.length}`);
	assert.match(text, /output capped/);
});

test("transcriptOf resolves this session and local targets only",
	async () => {
	const { agent } = makeAgent();
	const selfPath = join(sessionDir, "self.jsonl");
	agent.rememberSession(selfPath);
	assert.equal((await agent.transcriptOf()).path, selfPath);
	assert.equal((await agent.transcriptOf(agent.id)).path, selfPath);

	agent.snapshot = async () => ([
		{ id: "local-fork", name: "local", role: "fork", pid: 1,
			parent: null, session: join(sessionDir, "fork.jsonl"),
			online: true },
		{ id: "remote-fork", name: "rem", role: "fork", pid: 2,
			parent: null, session: "/other/rem.jsonl", online: true,
			remote: true, origin: "beta" },
		{ id: "no-session", name: "ns", role: "fork", pid: 3,
			parent: null, session: null, online: true },
	]);
	assert.equal((await agent.transcriptOf("local-fork")).path,
		join(sessionDir, "fork.jsonl"));
	await assert.rejects(() => agent.transcriptOf("ghost"), /team_ls/);
	await assert.rejects(() => agent.transcriptOf("remote-fork"), /peer/);
	await assert.rejects(() => agent.transcriptOf("no-session"),
		/not recorded/);
});

test("team_peek reads this session's transcript, not the newest file",
	async () => {
	const tools = new Map();
	const pi = {
		appendEntry: () => {}, sendMessage: () => {}, on: () => {},
		registerEntryRenderer: () => {}, registerCommand: () => {},
		registerTool: (definition) => tools.set(definition.name, definition),
	};
	const previous = globalThis.__piTeamsAgent;
	globalThis.__piTeamsAgent = undefined;
	try {
		const { default: register } =
			await import("../extensions/pi-teams.ts");
		await register(pi);
		const app = globalThis.__piTeamsAgent;
		const selfPath = writeTranscript("peek-self.jsonl", [{ type: "message",
			message: { role: "user", content: "SELF-MARKER" } }]);
		const otherPath = writeTranscript("peek-other.jsonl", [{ type: "message",
			message: { role: "user", content: "OTHER-MARKER" } }]);
		const future = new Date(Date.now() + 60_000);
		utimesSync(otherPath, future, future);
		app.rememberSession(selfPath);
		app.snapshot = async () => [];
		const result = await tools.get("team_peek").execute("call-1", {});
		assert.match(result.content[0].text, /SELF-MARKER/);
		assert.doesNotMatch(result.content[0].text, /OTHER-MARKER/);
		assert.equal(result.details.path, selfPath);
	} finally {
		if (previous === undefined) delete globalThis.__piTeamsAgent;
		else globalThis.__piTeamsAgent = previous;
	}
});

test("team_ls shows name, parent, cwd, you, and peer", async () => {
	const tools = new Map();
	const pi = {
		appendEntry: () => {}, sendMessage: () => {}, on: () => {},
		registerEntryRenderer: () => {}, registerCommand: () => {},
		registerTool: (definition) => tools.set(definition.name, definition),
	};
	const previous = globalThis.__piTeamsAgent;
	globalThis.__piTeamsAgent = undefined;
	try {
		const { default: register } =
			await import("../extensions/pi-teams.ts");
		await register(pi);
		const app = globalThis.__piTeamsAgent;
		app.id = "me";
		app.snapshot = async () => ([
			{ id: "me", name: "pi@/work", role: "main", pid: 1,
				parent: null, session: null, cwd: "/work", online: true },
			{ id: "kid", name: "task-slug", role: "fork", pid: 2,
				parent: "me", session: null, cwd: "/repo", online: true },
			{ id: "far", name: "rem", role: "fork", pid: 3,
				parent: null, session: null, online: true, remote: true,
				origin: "beta" },
		]);
		app.peers = async () => [];
		const result = await tools.get("team_ls").execute("call-1", {});
		const text = result.content[0].text;
		assert.match(text, /me\tmain\tonline\t\(you\)/);
		assert.match(text,
			/kid\tfork\tonline\t"task-slug"\tteammate of me\tcwd \/repo/);
		assert.match(text, /far\tfork\tonline\t"rem"\tpeer/);
	} finally {
		if (previous === undefined) delete globalThis.__piTeamsAgent;
		else globalThis.__piTeamsAgent = previous;
	}
});


function assistantLine(text) {
	return JSON.stringify({ type: "message", message: {
		role: "assistant", content: [{ type: "text", text }] } });
}

function emptyTranscript(name) {
	const path = join(sessionDir, name);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(path, "");
	return path;
}

function renderSlot() {
	return {};
}

const viewTheme = {
	fg: (_color, text) => text, bold: (text) => text,
	italic: (text) => text,
};

test("TranscriptTail returns only the lines added since the last read", () => {
	const path = emptyTranscript("tail-append.jsonl");
	const tail = new TranscriptTail(path);
	assert.deepEqual(tail.read(), []);
	appendFileSync(path,
		assistantLine("one") + "\n" + assistantLine("two") + "\n");
	assert.deepEqual(tail.read(), [assistantLine("one"), assistantLine("two")]);
	assert.deepEqual(tail.read(), [], "a read with no new bytes is empty");
	appendFileSync(path, assistantLine("three") + "\n");
	assert.deepEqual(tail.read(), [assistantLine("three")]);
});

test("TranscriptTail holds a partial line until it completes", () => {
	const path = emptyTranscript("tail-partial.jsonl");
	const tail = new TranscriptTail(path);
	const line = assistantLine("half written");
	appendFileSync(path, line.slice(0, 20));
	assert.deepEqual(tail.read(), []);
	appendFileSync(path, line.slice(20) + "\n");
	const lines = tail.read();
	assert.equal(lines.length, 1);
	assert.equal(JSON.parse(lines[0]).message.content[0].text, "half written");
});

test("TranscriptTail keeps a character split across two reads", () => {
	const path = emptyTranscript("tail-utf8.jsonl");
	const bytes = Buffer.from(assistantLine("café ☕ done") + "\n", "utf8");
	// Split inside the two bytes of "é".
	const split = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
	writeFileSync(path, bytes.subarray(0, split));
	const tail = new TranscriptTail(path);
	assert.deepEqual(tail.read(), []);
	appendFileSync(path, bytes.subarray(split));
	const lines = tail.read();
	assert.equal(lines.length, 1);
	assert.equal(JSON.parse(lines[0]).message.content[0].text, "café ☕ done");
});

test("TranscriptTail resumes when the transcript is rewritten", () => {
	const path = emptyTranscript("tail-rewrite.jsonl");
	writeFileSync(path,
		assistantLine("first") + "\n" + assistantLine("second") + "\n");
	const tail = new TranscriptTail(path);
	assert.equal(tail.read().length, 2);
	// A resumed session rewrites the file shorter: the cursor is past
	// its end, so the tail restarts from the window instead of throwing.
	writeFileSync(path, assistantLine("third") + "\n");
	const lines = tail.read();
	assert.equal(lines.length, 1);
	assert.match(lines[0], /third/);
});

test("TranscriptTail starts inside the tail of a large transcript", () => {
	const path = emptyTranscript("tail-large.jsonl");
	const all = [];
	for (let i = 0; i < 4000; i++) all.push(assistantLine(`entry ${i}`));
	writeFileSync(path, all.join("\n") + "\n");
	const read = new TranscriptTail(path).read();
	assert.ok(read.length > 0 && read.length < 4000, `read ${read.length}`);
	assert.match(read.at(-1), /entry 3999/);
	const bytes = read.reduce((n, line) => n + Buffer.byteLength(line), 0);
	assert.ok(bytes <= 16 * 1024, `${bytes} bytes backfilled`);
});

test("TranscriptTail reports a transcript that does not exist yet", () => {
	const path = join(sessionDir, "tail-missing.jsonl");
	if (existsSync(path)) unlinkSync(path);
	const tail = new TranscriptTail(path);
	assert.deepEqual(tail.read(), []);
	assert.equal(tail.missing, true);
	writeFileSync(path, assistantLine("now here") + "\n");
	assert.match(tail.read()[0], /now here/);
	assert.equal(tail.missing, false);
});

test("TeamWaitFeed bounds the snapshot and keeps every stream", () => {
	const snapshots = [];
	const feed = new TeamWaitFeed(["a", "b", "c"],
		(snapshot) => snapshots.push(snapshot), 0);
	for (const id of ["a", "b", "c"]) {
		for (let i = 0; i < 1000; i++) {
			feed.note(id, `[assistant] ${id} line ${i} `.repeat(4));
		}
	}
	feed.publish(1000);
	assert.equal(snapshots.length, 1);
	const { text, streams } = snapshots[0];
	assert.ok(Buffer.byteLength(text, "utf8") <= 16 * 1024,
		`${Buffer.byteLength(text, "utf8")} bytes snapshotted`);
	assert.deepEqual(streams.map((stream) => stream.id), ["a", "b", "c"]);
	for (const stream of streams) {
		assert.ok(stream.lines.length >= 1,
			`${stream.id} keeps at least one line`);
	}
});

test("TeamWaitFeed publishes only when the snapshot changes", () => {
	const snapshots = [];
	const feed = new TeamWaitFeed(["a"],
		(snapshot) => snapshots.push(snapshot), 0);
	feed.mark("a", "live");
	feed.publish(1000);
	assert.equal(snapshots.length, 1);
	feed.publish(1200);
	assert.equal(snapshots.length, 1, "an unchanged snapshot is not resent");
	feed.publish(3000);
	assert.equal(snapshots.length, 2, "the elapsed header moves the wait on");
	feed.close();
	feed.note("a", "[assistant] after close");
	feed.publish(9000);
	assert.equal(snapshots.length, 2, "a closed feed delivers nothing");
});

test("TeamWaitStream follows a transcript and names an unreadable peer",
	async () => {
	const local = emptyTranscript("wait-local.jsonl");
	const snapshots = [];
	const feed = new TeamWaitFeed(["kid", "peer-kid"],
		(snapshot) => snapshots.push(snapshot), 0);
	const source = {
		transcriptsOf: async (ids) => ids.map((id) => id === "kid"
			? { id, path: local }
			: { id, peer: true, error: `${id} runs on peer alpha` }),
	};
	const stream = new TeamWaitStream(["kid", "peer-kid"], source, feed);
	stream.start();
	await new Promise((resolve) => setImmediate(resolve));
	stream.tick(1000);
	appendFileSync(local, assistantLine("working on it") + "\n");
	stream.tick(2000);
	const last = snapshots.at(-1);
	assert.match(last.text, /kid \(live\)/);
	assert.match(last.text, /\[assistant\] working on it/);
	assert.match(last.text, /peer-kid \(peer: no live view\)/);
	stream.close();
	const delivered = snapshots.length;
	appendFileSync(local, assistantLine("after close") + "\n");
	stream.tick(3000);
	assert.equal(snapshots.length, delivered,
		"a closed stream stops reading and delivering");
});

test("TeamWaitView shows every stream while a wait blocks", () => {
	const view = new TeamWaitView();
	const streams = ["a", "b", "c"].map((id) => ({
		id, state: "live",
		lines: Array.from({ length: 20 }, (_v, i) => `${id} line ${i}`),
	}));
	const partial = view.render({
		content: [{ type: "text", text: "waiting" }],
		details: { streams },
	}, { expanded: false, isPartial: true }, viewTheme, renderSlot());
	const text = partial.render(80).join("\n");
	for (const id of ["a", "b", "c"]) {
		assert.match(text, new RegExp(`── ${id} \\(live\\) ──`));
		assert.match(text, new RegExp(`${id} line 19`),
			`${id}'s newest line is in view`);
	}
	// The marker is a bold header band; activity is set apart by its
	// color, so no line of output is indented.
	for (const line of text.split("\n")) {
		assert.doesNotMatch(line, /^ /, `activity line is flush: ${line}`);
	}
});

test("TeamWaitView colors activity by kind and marks an empty stream", () => {
	const view = new TeamWaitView();
	const palette = {
		fg: (color, text) => `<${color}:${text}>`,
		bold: (text) => `*${text}*`,
		italic: (text) => `/${text}/`,
	};
	const partial = view.render({
		content: [{ type: "text", text: "waiting" }],
		details: { streams: [
			{ id: "a", state: "live", lines: [
				"[user] go",
				"[assistant] working",
				"[tool bash] ls",
				"[tool bash error] boom",
				"[custom hook] note",
				"[custom] bare",
				"[compaction] trimmed",
			] },
			{ id: "b", state: "starting", lines: [] },
		] },
	}, { expanded: true, isPartial: true }, palette, renderSlot())
		.render(80).join("\n");
	assert.match(partial, /^<accent:\[user\]> <accent:go>/m);
	assert.match(partial, /^<success:\[assistant\]> <text:working>/m);
	assert.match(partial, /^<toolTitle:\[tool bash\]> <toolOutput:ls>/m);
	assert.match(partial, /^<error:\[tool bash error\]> <error:boom>/m);
	assert.match(partial,
		/^<customMessageLabel:\[custom hook\]> <customMessageText:note>/m);
	assert.match(partial,
		/^<customMessageLabel:\[custom\]> <customMessageText:bare>/m);
	assert.match(partial,
		/^<thinkingText:\[compaction\]> \/<thinkingText:trimmed>\//m);
	assert.match(partial, /^<dim:\(no activity yet\)>/m);
	assert.match(partial, /<toolTitle:\*── a\*>/,
		"the marker stays bold and framed");
});

test("TeamWaitView previews a long final report", () => {
	const view = new TeamWaitView();
	const text = Array.from({ length: 25 }, (_v, i) => `row ${i}`).join("\n");
	const result = { content: [{ type: "text", text }], details: {} };
	const collapsed = view.render(result,
		{ expanded: false, isPartial: false }, viewTheme, renderSlot())
		.render(80).join("\n");
	assert.match(collapsed, /row 9/);
	assert.doesNotMatch(collapsed, /row 10\n/);
	assert.match(collapsed, /15 more lines; expand the tool to show all/);
	const expanded = view.render(result,
		{ expanded: true, isPartial: false }, viewTheme, renderSlot())
		.render(80).join("\n");
	assert.match(expanded, /row 24/);
});

test("transcriptsOf resolves every id from one registry snapshot",
	async () => {
	const { agent } = makeAgent();
	let calls = 0;
	agent.snapshot = async () => {
		calls += 1;
		return [
			{ id: "local-fork", name: "local", role: "fork", pid: 1,
				parent: null, session: join(sessionDir, "fork.jsonl"),
				online: true },
			{ id: "remote-fork", name: "rem", role: "fork", pid: 2,
				parent: null, session: "/other/rem.jsonl", online: true,
				remote: true, origin: "beta" },
			{ id: "no-session", name: "ns", role: "fork", pid: 3,
				parent: null, session: null, online: true },
		];
	};
	const refs = await agent.transcriptsOf(
		["local-fork", "remote-fork", "no-session", "ghost"]);
	assert.equal(calls, 1, "one snapshot serves every id");
	assert.equal(refs[0].path, join(sessionDir, "fork.jsonl"));
	assert.equal(refs[1].peer, true);
	assert.match(refs[2].error, /not recorded/);
	assert.match(refs[3].error, /team_ls/);
});

test("team_wait streams teammate activity and keeps its report text",
	async () => {
	const tools = new Map();
	const pi = {
		appendEntry: () => {}, sendMessage: () => {}, on: () => {},
		registerEntryRenderer: () => {}, registerCommand: () => {},
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
		const transcript = emptyTranscript("wait-tool.jsonl");
		const report = {
			from: "kid", to: app.id, kind: "result", payload: "all done",
		};
		app.setState = () => {};
		app.setBusy = () => {};
		app.transcriptsOf = async (ids) => ids.map((id) => ({ id, path: transcript }));
		// Stand in for the wait: append a line, let the stream resolve
		// the transcript, then tick it once, as the real poll would.
		app.waitForResults = async (_ids, _timeout, _signal, _yield, onTick) => {
			appendFileSync(transcript, assistantLine("still working") + "\n");
			await new Promise((resolve) => setImmediate(resolve));
			onTick();
			return { results: [report], interruptedBy: null };
		};
		const updates = [];
		const result = await tools.get("team_wait").execute("call-1",
			{ ids: ["kid"] }, undefined,
			(update) => updates.push(update),
			{ hasPendingMessages: () => false });
		// The model-facing result is unchanged by the live view.
		assert.equal(result.content[0].text, formatReport(report));
		assert.deepEqual(result.details.remaining, []);
		const partial = updates.at(-1);
		assert.match(partial.content[0].text, /still working/);
		assert.equal(partial.details.streams[0].id, "kid");
		// The stream ends with the wait: nothing lands after the result.
		const delivered = updates.length;
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(updates.length, delivered);
	} finally {
		if (previous === undefined) delete globalThis.__piTeamsAgent;
		else globalThis.__piTeamsAgent = previous;
	}
});

/** A minimal ExtensionAPI double for the remote-work guard. */
function makeGuardPi() {
	const handlers = new Map();
	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		async emit(name, event) {
			const results = [];
			for (const handler of handlers.get(name) ?? []) {
				results.push(await handler(event));
			}
			return results;
		},
	};
	return pi;
}

function guardPi(enabled = true) {
	const pi = makeGuardPi();
	const settings = { remoteGuard: () => enabled };
	new TeamsRemoteGuard(settings, new RemoteWorkClassifier()).register(pi);
	return pi;
}

test("remote guard: refuses ssh work, tunnels, and headless pi", async () => {
	const pi = guardPi();
	const blocked = [
		"ssh host", "ssh -T host", "ssh host make",
		"ssh -p 2222 -i k host 'git pull'", "ssh host pi -p x",
		"cd x && ssh host ls", "bash -c \"ssh host ls\"",
		"sudo env A=1 timeout 5 ssh host ls",
		"echo $(ssh host hostname)", "ssh -o RemoteCommand=ls host",
		"ssh host -T", "ssh host -o RemoteCommand=make",
		"(cd x && ssh host make)", "pi -p update",
		"rsync --rsync-path='sh -c x' a host:b",
		"ssh host 'tar x --to-command=sh'",
		"pi -p x", "pi --print x", "pi --mode rpc", "pi \"prompt\"",
		"git diff | pi x", "ssh -N -L 1:h:2 host",
	];
	for (const command of blocked) {
		const [result] = await pi.emit("tool_call",
			{ toolName: "bash", input: { command } });
		assert.equal(result?.block, true, `must block: ${command}`);
		assert.match(result.reason, /pi-teams/);
	}
});

test("remote guard: keeps file transfer and pi management", async () => {
	const pi = guardPi();
	const allowed = [
		"scp a host:b", "scp -P 2222 -i k host:a .",
		"sftp -b batch host", "rsync -az -e 'ssh -p 2222' d host:d",
		"ssh host 'cat > f' < f",
		"tar c d | ssh host 'mkdir -p d && tar x -C d'",
		"ssh host sha256sum f", "ssh host -- cat f",
		"ssh -V", "ssh -G host",
		"ssh-keygen -t ed25519", "grep -rn ssh README.md",
		"pi install npm:x", "pi update", "pi list", "pi --version",
	];
	for (const command of allowed) {
		const [result] = await pi.emit("tool_call",
			{ toolName: "bash", input: { command } });
		assert.equal(result, undefined, `must stay allowed: ${command}`);
	}
});

test("remote guard: a heredoc body is data unless a shell runs it", async () => {
	const pi = guardPi();
	const verdict = async (command) => {
		const [result] = await pi.emit("tool_call",
			{ toolName: "bash", input: { command } });
		return result;
	};
	for (const command of [
		"python - <<'PY'\npi = e.get('pi') if e else None\nPY",
		"cat > notes.txt <<'EOF'\nssh host rm -rf /tmp/x\nEOF",
		"cat <<'EOF'\n$(ssh host id)\nEOF",
		"bash script.sh <<'EOF'\nssh host id\nEOF",
		"bash <<'EOF' 1>&2 </dev/null\nssh host id\nEOF",
		"bash <<'EOF' >3</dev/null\nssh host id\nEOF",
		"bash <<'EOF' > 3</dev/null\nssh host id\nEOF",
		"bash <<'A' 3<&0 <<'B' <&0\nssh host id\nA\nplain\nB",
		"cat <<'A' | bash <<'B'\nssh host id\nA\nprintf safe\nB",
		"cat <<'A' | bash < /dev/null\nssh host id\nA",
		"cat <<'A' | bash 3</dev/null <&3\nssh host id\nA",
		"cat <<'A' | bash 3<&0 <<'B'\nssh host id\nA\nprintf safe\nB",
		"bash 3<<'EOF' <& 3</dev/null\nssh host id\nEOF",
		"bash <<\"EOF\"\nsafe\nEOF",
		"bash <<$'EOF'\nsafe\nEOF",
		"bash 3<<'EOF' <&$'\\0'\nssh host id\nEOF",
		"bash 3<<'EOF' <&$'\\UFFFFFFFF'\nssh host id\nEOF",
		"bash 3<<'EOF' <&$'\\u0034'\nssh host id\nEOF",
		"bash 3<<'EOF' <&$'4'\nssh host id\nEOF",
		"bash <<'EOF' >>3<file\nssh host id\nEOF",
		"bash <<'EOF' >out3</dev/null\nssh host id\nEOF",
		"bash <<'EOF' > >(cat; :) </dev/null\nssh host id\nEOF",
		"bash <<'EOF' >$(printf /dev/null) </dev/null\nssh host id\nEOF",
		"bash <<'EOF' >$(printf /dev/null; :) </dev/null\nssh host id\nEOF",
		"bash <<'EOF' x#y </dev/null\nssh host id\nEOF",
		"bash +s script.sh <<'EOF'\nssh host id\nEOF",
		"bash -s +s script.sh <<'EOF'\nssh host id\nEOF",
		"bash -eo posix script.sh <<'EOF'\nssh host id\nEOF",
		"bash '-c' 'x' <<'EOF'\nssh host id\nEOF",
		"bash <<'EOF' $(printf '')script.sh\nssh host id\nEOF",
		"bash <<'EOF' \"\"$(printf '')\nssh host id\nEOF",
		"bash <<'EOF' \"$(printf '')\"\nssh host id\nEOF",
		"bash <<'EOF' $(x) script.sh\nssh host id\nEOF",
		"bash 3<<'EOF' <&3 < <(cat)\nssh host id\nEOF",
		"bash 3<<'EOF' 4<&03\nssh host id\nEOF",
		"bash 3<<'EOF' 4>& 3\nssh host id\nEOF",
		"bash 3<<'EOF' 4>&'3'\nssh host id\nEOF",
		"bash 3<<'EOF' 3>out <&3\nssh host id\nEOF",
		"bash <<'EOF' 0>out\nssh host id\nEOF",
		"bash 3<<'EOF' 4>&3\nssh host id\nEOF",
		"bash 3<<'EOF' & cat <&3\nssh host id\nEOF",
		"bash 3<<'EOF' 4<&3\nssh host id\nEOF",
		"bash <<'EOF' <&3\nssh host id\nEOF",
		"bash - script.sh <<'EOF'\nssh host id\nEOF",
		"bash -- script.sh <<'EOF'\nssh host id\nEOF",
		"bash -- -s <<'EOF'\nssh host id\nEOF",
		"bash -c 'printf safe' -s <<'EOF'\nssh host id\nEOF",
		"bash script.sh -s <<'EOF'\nssh host id\nEOF",
		"bash <<'EOF' 'x<y'\nssh host id\nEOF",
		"bash 3<<'EOF'\nssh host id\nEOF",
		"bash 3<<EOF\nssh host id\nEOF",
		"bash <<EOF\nprintf '%s' '\\$(ssh host id)'\nEOF",
		"cat <<'E'; bash </dev/null\nssh host id\nE",
		"cat <<'E'; bash\nssh host id\nE",
		"bash -c 'make' <<'EOF'\nssh host id\nEOF",
		"bash <<'EOF' 0</dev/null\nssh host id\nEOF",
	]) {
		assert.equal(await verdict(command), undefined,
			`the body is data: ${command}`);
	}
	for (const command of [
		"bash - <<'SH'\nssh host id\nSH",
		"bash <<'A' 3<&0 <<'B' <&3\nssh host id\nA\nplain\nB",
		"cat <<'A' | bash <<'B'\nprintf safe\nA\nssh host id\nB",
		"cat <<'A' | bash\nssh host id\nA",
		"cat <<'A' | bash 3</dev/null\nssh host id\nA",
		"cat <<'A' | bash 3<&0 <<'B' <&3\nssh host id\nA\nprintf safe\nB",
		"bash <<'EOF' 1>&2 <&0\nssh host id\nEOF",
		"sudo bash <<'SH'\nssh host id\nSH",
		"sh <<-EOF\n\tssh host id\n\tEOF",
		"cat <<EOF\n$(ssh host id)\nEOF",
		"cat <<'EOF' | bash\nssh host id\nEOF",
		"  bash <<'EOF'\nssh host id\nEOF",
		"bash <<'EOF' 3</dev/null\nssh host id\nEOF",
		"bash </dev/null <<'EOF'\nssh host id\nEOF",
		"bash <<''\nssh host id\n\n",
		"bash <<EOF\nprintf '%s' '$(ssh host id)'\nEOF",
		"bash <<EOF\nprintf '%s' \"\\$(ssh host id)\"\nEOF",
		"cat <<EOF\nlit \\\n$(ssh host id)\nEOF",
		"cat <<EOF\nE\\\nOF\nssh host id",
		"bash 0<<'EOF'\nssh host id\nEOF",
		"bash <<'A' 3<<'B'\nssh host id\nA\nplain\nB",
		"bash 3<<'A' <<'B'\nplain\nA\nssh host id\nB",
		"bash <<'EOF' >\" <ignored\"\nssh host id\nEOF",
		"bash <<'EOF' >\"a<b\"\nssh host id\nEOF",
		"bash -s arg <<'EOF'\nssh host id\nEOF",
		"bash -- <<'EOF'\nssh host id\nEOF",
		"bash +e <<'EOF'\nssh host id\nEOF",
		"bash -s -- arg <<'EOF'\nssh host id\nEOF",
		"bash --noprofile <<'EOF'\nssh host id\nEOF",
		"bash --rcfile f <<'EOF'\nssh host id\nEOF",
		"bash 3<<'EOF' <&3\nssh host id\nEOF",
		"bash 3<<'EOF' 4<&3 <&4\nssh host id\nEOF",
		"bash <<'EOF' & cat </dev/null\nssh host id\nEOF",
		"bash 3<<'EOF' 0>&3\nssh host id\nEOF",
		"bash <<'EOF' 3>&0 <&3\nssh host id\nEOF",
		"bash 3<<'EOF' <&'3'\nssh host id\nEOF",
		"bash 3<<'EOF' <&\\3\nssh host id\nEOF",
		"bash 3<<'EOF' <& 3\nssh host id\nEOF",
		"bash <&0 -s arg <<'EOF'\nssh host id\nEOF",
		"bash 2>&1 <<'EOF'\nssh host id\nEOF",
		"bash 3<<'EOF' <&\\\n3\nssh host id\nEOF",
		"bash 3<<'EOF' <&\\\n 3\nssh host id\nEOF",
		"bash 3<<'EOF' <&\"\\\n3\"\nssh host id\nEOF",
		"bash 3<<'EOF' <&$'3'\nssh host id\nEOF",
		"bash 3<<'EOF' <&$'\\063'\nssh host id\nEOF",
		"bash 3<<'EOF' <&$'\\x33'\nssh host id\nEOF",
		"bash 3<<'EOF' <&$'\\u0033'\nssh host id\nEOF",
		"bash 3<<'EOF' <&$'\\U00000033'\nssh host id\nEOF",
		"bash 3<<'EOF' <&$'\\u33'\nssh host id\nEOF",
		"bash 3<<'EOF' <&$'3\\0ignored'\nssh host id\nEOF",
		"cat <<$'EOF'\nsafe\nEOF\nssh host id",
		"bash <<$'\\u0045OF'\nssh host id\nEOF",
		"cat <<\"E\\OF\"\nsafe\nE\\OF\nssh host id",
		"bash 3<<'EOF' <& '3'\nssh host id\nEOF",
		"bash 3<<'EOF' <&3-\nssh host id\nEOF",
		"bash 3<<'EOF' <&03\nssh host id\nEOF",
		"bash <<'EOF' > >(cat </dev/null)\nssh host id\nEOF",
		"bash <<'EOF' >$(printf /dev/null </dev/null)\nssh host id\nEOF",
		"bash <<'EOF' >`cat </dev/null`\nssh host id\nEOF",
		"bash <<'EOF' $(printf '')\nssh host id\nEOF",
		"bash -- $(printf '') <<'EOF'\nssh host id\nEOF",
		"bash '-s' arg <<'EOF'\nssh host id\nEOF",
		"bash '--' <<'EOF'\nssh host id\nEOF",
		"bash -eo posix <<'EOF'\nssh host id\nEOF",
		"bash -euo posix <<'EOF'\nssh host id\nEOF",
		"bash +s -s script.sh <<'EOF'\nssh host id\nEOF",
		"bash <<'EOF' # </dev/null\nssh host id\nEOF",
		"bash <<'EOF' #<stdin\nssh host id\nEOF",
		"bash <<'EOF' # x\nssh host id\nEOF",
		"bash <<'EOF' >$(printf /dev/null; :)\nssh host id\nEOF",
		"bash <<'EOF' > >(cat; :)\nssh host id\nEOF",
		"bash <<'EOF' >out3\nssh host id\nEOF",
		"bash <<'EOF' >o3 <&0\nssh host id\nEOF",
		"bash <<'A'; cat </dev/null\nssh host id\nA",
		"bash <<'A'; cat <<'B'\nssh host id\nA\nsafe\nB",
		"bash <<'OUT'\nsh <<'IN'\nssh host id\nIN\nOUT",
	]) {
		assert.equal((await verdict(command))?.block, true,
			`the shell runs the body: ${command}`);
	}
});

test("remote guard: covers powershell and never foreign tools", async () => {
	const pi = guardPi();
	const [powershell] = await pi.emit("tool_call",
		{ toolName: "powershell", input: { command: "ssh host ls" } });
	assert.equal(powershell.block, true);
	const [foreign] = await pi.emit("tool_call",
		{ toolName: "read", input: { path: "x" } });
	assert.equal(foreign, undefined);
	const [submitted] = await pi.emit("tool_call",
		{ toolName: "daemon_tasks",
			input: { action: "submit", command: "pi -p x" } });
	assert.equal(submitted.block, true,
		"a daemon_tasks submit cannot smuggle a headless pi");
	const [status] = await pi.emit("tool_call",
		{ toolName: "daemon_tasks", input: { action: "status" } });
	assert.equal(status, undefined);
	const [empty] = await pi.emit("tool_call",
		{ toolName: "bash", input: { command: "   " } });
	assert.equal(empty, undefined);
});

test("remote guard: disabled leaves ssh alone", async () => {
	const pi = guardPi(false);
	const [result] = await pi.emit("tool_call",
		{ toolName: "bash", input: { command: "ssh host ls" } });
	assert.equal(result, undefined);
});

test("teammates dock: a failed presentation reports why", async () => {
	const notices = [];
	const ctx = {
		mode: "tui",
		ui: {
			custom: async () => {
				throw new Error("no dock here");
			},
			notify: (message, kind) => notices.push({ message, kind }),
		},
	};
	await openTeammatesDock([], ctx);
	assert.deepEqual(notices, [{
		message: "pi-teams: teammates dock failed: no dock here",
		kind: "error",
	}]);
});

test("settings dock: a failed presentation reports why above the listing",
	async () => {
		const notices = [];
		const ui = {
			custom: async () => {
				throw new Error("no dock here");
			},
			notify: (message, kind) => notices.push({ message, kind }),
		};
		await new TeamSettingsPresenter().present(ui, "tui", () => {});
		assert.equal(notices.length, 1, "one notice, not a silent fallback");
		assert.equal(notices[0].kind, "error");
		assert.match(notices[0].message, /no dock here/,
			"the reason is carried");
		assert.match(notices[0].message, /pi-teams-settings:/,
			"the listing still answers");
	});

test("settings dock: a successful presentation reports nothing", async () => {
	const notices = [];
	const ui = {
		custom: async (factory) => {
			factory({}, { fg: (_c, text) => text }, {}, () => {});
		},
		notify: (message) => notices.push(message),
	};
	await new TeamSettingsPresenter().present(ui, "tui", () => {});
	assert.deepEqual(notices, [], "no notice on the success path");
});

test("settings dock: a row that throws on input is reported, not thrown",
	async () => {
		const notices = [];
		let view;
		const ui = {
			custom: async (factory) => {
				view = factory({}, { fg: (_c, text) => text }, {}, () => {});
			},
			notify: (message) => notices.push(message),
		};
		const presenter = new TeamSettingsPresenter();
		const rows = presenter.rows();
		rows[0].submenu = () => {
			throw new Error("Theme not initialized. Call initTheme() first.");
		};
		presenter.rows = () => rows;
		await presenter.present(ui, "tui", () => {});
		assert.ok(view !== undefined, "the dock mounted");
		view.selectItem(rows[0].id);
		view.handleInput("\r");
		assert.ok(notices.length >= 1,
			"the build failure is reported, not thrown");
		assert.match(notices[0], /Theme not initialized/,
			"the original reason is carried");
		assert.ok(view.render(80).length > 0, "the dock keeps rendering");
		view.handleInput("\u001b[B");
	});
