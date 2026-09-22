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
 *   - spawn forwards the fork identity (parent/role) in the environment
 *     and detaches the teammate;
 *   - spawnTask builds the common teammate template (session, model,
 *     and the report-back instruction) from a task alone, and no
 *     custom spawn path exists.
 *
 * Runs on Node's built-in test runner; the extension is imported with
 * Node's TypeScript stripping. No broker or pi process is started.
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

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
	const results = await waiting;
	assert.equal(results.length, 1);
	assert.equal(results[0].payload, "done");
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
	const results = await agent.waitForResults(
		["kid"], 5000, undefined, () => false);
	assert.equal(results[0].payload, "early");
	agent.stopHold();
});

test("an active wait returns null on its bound", async () => {
	const { agent } = makeAgent();
	const results = await agent.waitForResults(
		["nobody"], 20, undefined, () => false);
	assert.deepEqual(results, [null]);
});

test("an active wait yields when a user message is queued", async () => {
	const { agent } = makeAgent();
	let pending = false;
	const waiting = agent.waitForResults(
		["kid"], 5000, undefined, () => pending);
	setTimeout(() => { pending = true; }, 20);
	assert.deepEqual(await waiting, [null]);
});

test("an active wait ends when the run aborts", async () => {
	const { agent } = makeAgent();
	const controller = new AbortController();
	const waiting = agent.waitForResults(
		["kid"], 5000, controller.signal, () => false);
	setTimeout(() => controller.abort(), 10);
	assert.deepEqual(await waiting, [null]);
});

test("deregister cancels an active wait", async () => {
	const { agent } = makeAgent();
	const waiting = agent.waitForResults(
		["kid"], 5000, undefined, () => false);
	await new Promise((resolve) => setTimeout(resolve, 10));
	agent.deregister();
	assert.deepEqual(await waiting, [null]);
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
	const results = await waiting;
	assert.equal(results[0], null);
	assert.equal(results[1].payload, "fast");
	agent.stopHold();
});

test("a buffered result ends a multi-id wait at once", async () => {
	const { agent, calls } = makeAgent(() => {});
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	onData(JSON.stringify({
		from: "kid", to: agent.id, kind: "result", payload: "early",
	}) + "\n");
	const results = await agent.waitForResults(
		["kid", "other"], 5000, undefined, () => false);
	assert.equal(results[0].payload, "early");
	assert.equal(results[1], null);
	agent.stopHold();
});

test("an active wait reports progress ticks", async () => {
	const { agent } = makeAgent();
	let ticks = 0;
	await agent.waitForResults(
		["nobody"], 600, undefined, () => false, () => { ticks += 1; });
	assert.ok(ticks >= 1);
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
	agent.stopHold();
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

test("spawning goes through one interface with no custom argv", () => {
	const { agent } = makeAgent();
	assert.equal(typeof agent.spawnTask, "function");
	assert.equal(typeof agent.spawn, "function");
	assert.equal(typeof agent.parseSpawn, "undefined", "no argv parser");
});

test("spawnTask builds the teammate template from a task alone", () => {
	publishEndpoint(true);
	process.env.PI_SESSION_BINDING = "1";
	process.env.PI_HOST_BINDING = "pi-parent";
	process.env.TEAM_SESSION = "parent-session";
	try {
		const { agent, calls } = makeAgent();
		agent.rememberSession(join(sessionDir, "sess.jsonl"));
		const ref = agent.spawnTask("worker", "summarize the diff", {
			provider: "openrouter", model: "m", thinking: "low",
		});
		assert.equal(ref.session, "worker");
		assert.ok(ref.id.startsWith(`${agent.host}:fork-`));
		const call = calls[0];
		assert.equal(call.file, process.execPath);
		assert.equal(call.args[0], process.argv[1]);
		assert.deepEqual(call.args.slice(1, 3), ["--mode", "rpc"]);
		assert.ok(call.args.includes("--session-dir"));
		assert.ok(call.args.includes("--name"));
		assert.ok(call.args.includes("--provider"));
		assert.ok(call.args.includes("--model"));
		assert.ok(call.args.includes("--thinking"));
		// The task is delivered as an RPC prompt, never as a -p task.
		assert.ok(!call.args.includes("-p"));
		assert.deepEqual(call.options.stdio, ["pipe", "ignore", "ignore"]);
		assert.equal(call.stdinWrites.length, 1);
		const sent = JSON.parse(call.stdinWrites[0].trim());
		assert.equal(sent.type, "prompt");
		assert.match(sent.message, /summarize the diff/);
		assert.match(sent.message, /TEAM_PARENT_ID/);
		assert.match(sent.message, /TEAM_ROOT/);
		// Report-back names the interpreter and the absolute client path,
		// never a bare `team` that needs a shebang or PATH.
		assert.ok(sent.message.includes(process.env.PYTHON));
		assert.ok(sent.message.includes(join(binDir, "team")));
		assert.equal(call.options.env.TEAM_ROOT, stateRoot);
		assert.equal(call.options.env.TEAM_PARENT_ID, "parent-1");
		// The teammate must not inherit the parent's session or host
		// binding, whichever layer set it; its own identity is set fresh.
		assert.equal(call.options.env.PI_SESSION_BINDING, undefined);
		assert.equal(call.options.env.PI_HOST_BINDING, undefined);
		assert.equal(call.options.env.PI_SESSION_FILE, undefined);
		assert.equal(call.options.env.TEAM_SESSION, undefined);
	} finally {
		delete process.env.PI_SESSION_BINDING;
		delete process.env.PI_HOST_BINDING;
		delete process.env.TEAM_SESSION;
	}
});

test("spawnTask resolves pi from the running runtime", () => {
	// Windows wraps pi as a .cmd/.ps1 shim that child_process cannot
	// execute without a shell; the runtime plus its entry script is
	// spawnable everywhere.
	publishEndpoint(true);
	const { agent, calls } = makeAgent();
	agent.rememberSession(join(sessionDir, "sess.jsonl"));
	agent.spawnTask("worker", "do it");
	assert.equal(calls.length, 1);
	const call = calls[0];
	assert.equal(call.file, process.execPath);
	assert.equal(call.args[0], process.argv[1]);
	assert.deepEqual(call.args.slice(1, 3), ["--mode", "rpc"]);
	assert.ok(!call.args.includes("--no-session"));
});

test("spawnTask context=inherit forks the parent session; fresh does not", () => {
	publishEndpoint(true);
	const { agent, calls } = makeAgent();
	agent.rememberSession(join(sessionDir, "sess.jsonl"));
	agent.spawnTask("a", "task a");
	assert.ok(!calls[0].args.includes("--fork"), "fresh by default");
	agent.spawnTask("b", "task b", { context: "inherit" });
	assert.deepEqual(calls[1].args.slice(1, 4), ["--mode", "rpc", "--fork"]);
	assert.equal(calls[1].args[4], join(sessionDir, "sess.jsonl"));

	// Inheriting without a parent session is refused.
	const bare = new TeamAgent(makeRunner().runner, () => {});
	assert.throws(
		() => bare.spawnTask("c", "task c", { context: "inherit" }),
		/no file to fork/);
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

test("spawn routes a peer host over the broker and returns the id", async () => {
	const sends = [];
	const { calls, runner } = makeRunner((file, args) => {
		if (args.includes("ls")) {
			return Promise.resolve({ stdout: JSON.stringify({ agents: [{
				id: "beta:main", name: "peer", role: "main", pid: 1,
				parent: null, session: null, online: false, origin: "beta",
				remote: true,
			}] }), stderr: "", code: 0 });
		}
		sends.push(args);
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	const pending = agent.spawn("beta", "worker", "do it");
	await new Promise((r) => setTimeout(r, 20));
	const sent = sends.find((a) => a.includes("spawn"));
	assert.ok(sent, "spawn request was not sent");
	const request = JSON.parse(sent[sent.length - 1]);
	onData(JSON.stringify({
		from: "beta:main", to: agent.id, kind: "spawn-ack",
		payload: { requestId: request.requestId, id: "beta:fork-1",
			session: "worker" },
	}) + "\n");
	const ref = await pending;
	assert.equal(ref.id, "beta:fork-1");
	assert.equal(ref.session, "worker");
	agent.stopHold();
});

test("spawn routes a host-less target to the local backend", async () => {
	const { calls, runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	const ref = await agent.spawn("", "local-kid", "do it");
	assert.ok(ref.id.includes(":fork-"), "not a locally spawned fork id");
	assert.equal(ref.session, "local-kid");
	// A local spawn launches a process; no broker send was needed.
	assert.ok(calls.length >= 2, "no local teammate process was spawned");
	agent.stopHold();
});

test("an inbound spawn request is spawned locally and acked", async () => {
	publishEndpoint(true);
	const sends = [];
	const { calls, runner } = makeRunner((file, args) => {
		sends.push(args);
		return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	});
	const agent = new TeamAgent(runner, () => {});
	agent.hold("/work");
	const onData = calls[0]["stdout:data"];
	onData(JSON.stringify({
		from: "alpha:main", to: agent.id, kind: "spawn",
		payload: { requestId: "r1", name: "kid", task: "do x" },
	}) + "\n");
	await new Promise((r) => setTimeout(r, 20));
	// The request spawned a local teammate and acked the requester.
	assert.ok(calls.length >= 2, "no teammate process was spawned");
	const ack = sends.find((a) => a.includes("spawn-ack"));
	assert.ok(ack, "no spawn-ack was sent");
	assert.ok(ack.includes("alpha:main"));
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
	const hold = calls[calls.length - 1];
	assert.equal(hold.options.env.TEAM_ID, agent.id);
	assert.equal(hold.options.env.TEAM_ROLE, "fork");
	assert.equal(hold.options.env.TEAM_PARENT_ID, "parent-9");
	assert.equal(hold.options.env.TEAM_NAME, "helper");
	const notice = sends.find((a) => a.includes("notice"));
	assert.ok(notice && notice.includes("parent-9"),
		"no attach notice was sent to the parent");
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
	const { runner } = makeRunner(() =>
		Promise.resolve({ stdout: "{}", stderr: "", code: 0 }));
	const agent = new TeamAgent(runner, () => {});
	if (savedId !== undefined) process.env.TEAM_ID = savedId;
	agent.hold("/work");
	// The empty snapshot means only the spawn itself can grant membership.
	assert.equal(await agent.isTeammate(), false);
	const ref = await agent.spawn("", "kid", "do it");
	assert.ok(ref, "local spawn returned no ref");
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

