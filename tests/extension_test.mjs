/**
 * Regression tests for the pi-teams extension.
 *
 * pi.exec opens a child's stdin to /dev/null and silently drops the env
 * option, so the extension must launch the held connection and forked
 * pi with Node's child_process directly:
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
process.env.PI_SESSION_FILE = join(scratch, "session.jsonl");
process.env.TEAM_ID = "parent-1";

const { TeamAgent, logTeamMessage } = await import("../extensions/pi-teams.ts");

process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function makeSpawn() {
	const calls = [];
	const spawnProcess = (file, args, options) => {
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
			on(event, _listener) {
				record["on:" + event] = true;
			},
			unref() {
				record.unrefed = true;
			},
			kill() {
				record.killed = true;
			},
		};
	};
	return { calls, spawnProcess };
}

function makeAgent(deliver = () => {}) {
	const { calls, spawnProcess } = makeSpawn();
	const exec = () => Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	return { agent: new TeamAgent(exec, spawnProcess, deliver), calls };
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
	assert.deepEqual(call.args, [`${binDir}/team`, "--root", stateRoot, "hold"]);
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
	const execCalls = [];
	const agent = new TeamAgent(
		async (_file, args) => {
			execCalls.push(args);
			return { stdout: "{}" };
		},
		() => {},
		() => {},
	);
	process.env.TEAM_PARENT_ID = "parent-9";
	try {
		await agent.announceSession("/x/sessions/sess.jsonl");
		assert.equal(execCalls.length, 1);
		const args = execCalls[0];
		assert.ok(args.includes("send"));
		assert.ok(args.includes("parent-9"));
		assert.ok(args.includes("notice"));
		assert.ok(args.some((a) => a.includes("sess.jsonl")));

		// No parent: nothing is sent.
		delete process.env.TEAM_PARENT_ID;
		await agent.announceSession("/x/sessions/sess.jsonl");
		assert.equal(execCalls.length, 1);

		// No session file: nothing is sent.
		process.env.TEAM_PARENT_ID = "parent-9";
		await agent.announceSession(null);
		assert.equal(execCalls.length, 1);
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

test("teammates can only be spawned through spawnTask", () => {
	const { agent } = makeAgent();
	assert.equal(typeof agent.spawnTask, "function");
	assert.equal(typeof agent.spawn, "undefined", "no custom spawn method");
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
		assert.ok(ref.id.startsWith("fork-"));
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
	const bare = new TeamAgent(
		() => Promise.resolve({ stdout: "{}" }),
		() => ({ stdin: null, stdout: null, on() {}, unref() {}, kill() {} }),
		() => {},
	);
	assert.throws(
		() => bare.spawnTask("c", "task c", { context: "inherit" }),
		/no file to fork/);
});

test("spawn starts a detached broker only when none is published", () => {
	publishEndpoint(false);
	const { agent, calls } = makeAgent();
	agent.ensureBroker();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, process.env.PYTHON || "python3");
	assert.deepEqual(calls[0].args, [`${binDir}/teamd`, "--root", stateRoot, "start"]);
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
