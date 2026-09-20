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
 *   - a default spawn is a named session in the parent's session
 *     directory, so the teammate is resumable after its process is GC'd;
 *   - /team spawn parses a standalone "--" separator, never the "--"
 *     of "--name".
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
delete process.env.PI_TEAMS_PI;
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
			killed: false,
			unrefed: false,
		};
		calls.push(record);
		return {
			stdin: {
				end() {
					record.stdinEnded = true;
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

test("spawn detaches the teammate with fork identity in the environment", () => {
	publishEndpoint(true);
	process.env.PI_TEAMS_PI = "pi-test";
	try {
		const { agent, calls } = makeAgent();
		agent.rememberSession(join(sessionDir, "sess.jsonl"));
		const sessionName = agent.spawn("worker", ["--model", "x", "-p", "hi"]);
		assert.equal(sessionName, "worker");
		assert.equal(calls.length, 1);
		const call = calls[0];
		assert.equal(call.file, "pi-test");
		assert.deepEqual(call.args, [
			"--session-dir", sessionDir, "--name", "worker",
			"--model", "x", "-p", "hi",
		]);
		assert.equal(call.options.detached, true);
		assert.equal(call.options.stdio, "ignore");
		assert.equal(call.options.windowsHide, true);
		assert.equal(call.options.env.TEAM_ROLE, "fork");
		assert.equal(call.options.env.TEAM_PARENT_ID, "parent-1");
		assert.equal(call.options.env.TEAM_NAME, "worker");
		assert.ok(call.options.env.TEAM_ID.startsWith("fork-"));
		// The child must not inherit the parent's session identity.
		assert.equal(call.options.env.TEAM_SESSION, undefined);
		assert.equal(call.options.env.PI_SESSION_FILE, undefined);
		assert.equal(call.unrefed, true);
	} finally {
		delete process.env.PI_TEAMS_PI;
	}
});

test("spawn refuses --no-session and names custom-arg teammates", () => {
	publishEndpoint(true);
	process.env.PI_TEAMS_PI = "pi-test";
	try {
		const { agent, calls } = makeAgent();
		agent.rememberSession(join(sessionDir, "sess.jsonl"));
		assert.throws(
			() => agent.spawn("worker", ["--no-session", "-p", "hi"]),
			/--no-session is not allowed/);
		assert.equal(calls.length, 0, "nothing spawned on refusal");

		// Custom args without session flags inherit the dir and a name.
		agent.spawn("worker", ["--model", "x", "-p", "hi"]);
		assert.deepEqual(calls[0].args, [
			"--session-dir", sessionDir, "--name", "worker",
			"--model", "x", "-p", "hi",
		]);
		// An explicit --name is respected.
		agent.spawn("other", ["--name", "chosen", "-p", "hi"]);
		assert.deepEqual(calls[1].args, [
			"--session-dir", sessionDir, "--name", "chosen", "-p", "hi",
		]);
	} finally {
		delete process.env.PI_TEAMS_PI;
	}
});

test("spawn resolves pi from the running runtime and names a resume session", () => {
	// Windows wraps pi as a .cmd/.ps1 shim that child_process cannot
	// execute without a shell; the runtime plus its entry script is
	// spawnable everywhere. The default teammate is a named session in
	// the parent's session directory, so /resume can find it after GC.
	publishEndpoint(true);
	delete process.env.PI_TEAMS_PI;
	const { agent, calls } = makeAgent();
	agent.rememberSession(join(sessionDir, "sess.jsonl"));
	agent.spawn("", []);
	assert.equal(calls.length, 1);
	const call = calls[0];
	assert.equal(call.file, process.execPath);
	assert.equal(call.args[0], process.argv[1]);
	assert.deepEqual(call.args.slice(1, 3), ["--session-dir", sessionDir]);
	assert.equal(call.args[3], "--name");
	assert.ok(call.args[4].startsWith("fork-"));
	assert.equal(call.args[5], "-p");
	assert.ok(call.args[6].length > 0);
	assert.ok(!call.args.includes("--no-session"));
	assert.ok(call.options.env.TEAM_NAME.startsWith("fork-"));
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

test("parseSpawn treats only a standalone -- as the argv separator", () => {
	const { agent } = makeAgent();
	assert.deepEqual(agent.parseSpawn("--name worker"), { name: "worker", argv: [] });
	assert.deepEqual(agent.parseSpawn("--name worker -- --model x -p hello"), {
		name: "worker",
		argv: ["--model", "x", "-p", "hello"],
	});
	assert.deepEqual(agent.parseSpawn("-- --model x -p hello"), {
		name: "",
		argv: ["--model", "x", "-p", "hello"],
	});
	assert.deepEqual(agent.parseSpawn("--name worker --"), { name: "worker", argv: [] });
	assert.deepEqual(agent.parseSpawn(""), { name: "", argv: [] });
	// Quoted prompts survive as one argument.
	assert.deepEqual(
		agent.parseSpawn('--name worker -- -p "do the thing" --model x'),
		{ name: "worker", argv: ["-p", "do the thing", "--model", "x"] });
	assert.deepEqual(agent.parseSpawn("--name worker -- -p 'quoted value'"),
		{ name: "worker", argv: ["-p", "quoted value"] });
});

test("deregister closes the held connection", () => {
	const { agent, calls } = makeAgent();
	agent.hold("/x");
	agent.deregister();
	assert.equal(calls[0].stdinEnded, true);
	assert.equal(calls[0].killed, true);
});
