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
process.env.TEAM_ROOT = stateRoot;
process.env.PI_TEAMS_BIN = binDir;
process.env.PI_TEAMS_PI = "pi";
process.env.PI_SESSION_FILE = join(scratch, "session.jsonl");
process.env.TEAM_ID = "parent-1";

const { TeamAgent } = await import("../extensions/pi-teams.ts");

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

function makeAgent() {
	const { calls, spawnProcess } = makeSpawn();
	const exec = () => Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
	return { agent: new TeamAgent(exec, spawnProcess), calls };
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
	assert.deepEqual(call.options.stdio, ["pipe", "ignore", "ignore"]);
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

test("spawn detaches the teammate with fork identity in the environment", () => {
	publishEndpoint(true);
	process.env.PI_TEAMS_PI = "pi-test";
	try {
		const { agent, calls } = makeAgent();
		agent.spawn("worker", ["--model", "x", "-p", "hi"]);
		assert.equal(calls.length, 1);
		const call = calls[0];
		assert.equal(call.file, "pi-test");
		assert.deepEqual(call.args, ["--model", "x", "-p", "hi"]);
		assert.equal(call.options.detached, true);
		assert.equal(call.options.stdio, "ignore");
		assert.equal(call.options.windowsHide, true);
		assert.equal(call.options.env.TEAM_ROLE, "fork");
		assert.equal(call.options.env.TEAM_PARENT_ID, "parent-1");
		assert.equal(call.options.env.TEAM_NAME, "worker");
		assert.ok(call.options.env.TEAM_ID.startsWith("fork-"));
		assert.equal(call.unrefed, true);
	} finally {
		delete process.env.PI_TEAMS_PI;
	}
});

test("spawn resolves pi from the running runtime, not a shell shim", () => {
	// Windows wraps pi as a .cmd/.ps1 shim that child_process cannot
	// execute without a shell; the runtime plus its entry script is
	// spawnable everywhere.
	publishEndpoint(true);
	delete process.env.PI_TEAMS_PI;
	const { agent, calls } = makeAgent();
	agent.spawn("", []);
	assert.equal(calls.length, 1);
	const call = calls[0];
	assert.equal(call.file, process.execPath);
	assert.equal(call.args[0], process.argv[1]);
	assert.deepEqual(call.args.slice(1, 3), ["--no-session", "-p"]);
	assert.ok(call.args[3].length > 0);
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
	assert.deepEqual(agent.parseSpawn("--name worker -- pi -p hello"), {
		name: "worker",
		argv: ["pi", "-p", "hello"],
	});
	assert.deepEqual(agent.parseSpawn("-- pi -p hello"), {
		name: "",
		argv: ["pi", "-p", "hello"],
	});
	assert.deepEqual(agent.parseSpawn("--name worker --"), { name: "worker", argv: [] });
	assert.deepEqual(agent.parseSpawn(""), { name: "", argv: [] });
});

test("deregister closes the held connection", () => {
	const { agent, calls } = makeAgent();
	agent.hold("/x");
	agent.deregister();
	assert.equal(calls[0].stdinEnded, true);
	assert.equal(calls[0].killed, true);
});
