/**
 * pi-teams - cross-pi-agent communication and self-forks.
 *
 * On session start this extension registers the running pi process with
 * the team broker (src/teamd.py) through a held connection, so the agent
 * gains an endpoint other agents can reach. A compact awareness note is
 * injected before the agent first runs, listing live teammates and the
 * commands used to reach or spawn them.
 *
 * This file is a thin entry point: it composes the responsibility
 * modules under ./pi-teams/ and registers the tools, events, and
 * command. The modules are not auto-discovered as extensions because
 * the subdirectory has no index.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { TeamAgent } from "./pi-teams/agent.ts";
import { ChatTail } from "./pi-teams/chat-tail.ts";
import {
	deliverToAgent,
	formatReport,
	logTeamMessage,
} from "./pi-teams/messages.ts";
import { sessionsRoot } from "./pi-teams/paths.ts";
import { ProcessRunner } from "./pi-teams/process-runner.ts";
import {
	DEFAULT_WAIT_SECONDS,
	waitSeconds,
	type TeamMessage,
} from "./pi-teams/protocol.ts";

// Re-exported so tests and embedders can reach the seam classes from the
// extension entry alone.
export { TeamAgent } from "./pi-teams/agent.ts";
export { ChatTail } from "./pi-teams/chat-tail.ts";
export { ProcessRunner } from "./pi-teams/process-runner.ts";
export {
	WindowlessPython,
	windowlessCandidates,
} from "./pi-teams/interpreter.ts";
export { logTeamMessage } from "./pi-teams/messages.ts";
export { AgentDirectory } from "./pi-teams/directory.ts";
export { ResultInbox } from "./pi-teams/inbox.ts";
export { PendingRequests } from "./pi-teams/pending.ts";
export { BrokerOps } from "./pi-teams/broker-ops.ts";
export { SpawnService } from "./pi-teams/spawn.ts";

export default async function (pi: ExtensionAPI) {
	const app = new TeamAgent(
		new ProcessRunner(),
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
			"the report arrives as a pi-teams message. The teammate starts " +
			"with a clean context and receives only the task, like a " +
			"subagent delegation, and runs with the general teammate role: " +
			"it reports to you, messages the team, waits, can lead its own " +
			"sub-team, and writes no memory.",
		promptSnippet:
			"Spawn a pi-teams teammate to do a task in its own session",
		promptGuidelines: [
			"Use team_spawn to delegate a bounded task to a teammate: it " +
				"runs as a separate pi session with its own /resume entry and " +
				"sends its result back as a pi-teams message. Pass a " +
				"self-contained task - the teammate starts with a clean " +
				"context and receives only the task text, like a subagent, " +
				"under the general teammate role (reporting, messaging, " +
				"waiting, leading its own sub-team). Call team_wait to block " +
				"for the report when you want to, or continue with other " +
				"work and let it arrive as a pi-teams message.",
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
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const model = ctx?.model;
			const host = params.host && params.host !== app.host
				? params.host
				: "";
			const ref = await app.spawn(host, params.name || "", params.task, {
				provider: model?.provider,
				model: model?.id,
				thinking: ctx?.thinkingLevel,
			});
			if (!ref) {
				if (!host) throw new Error("spawn failed");
				const agents = await app.snapshot();
				const advertised = agents.filter((a) =>
					a.remote && (!a.origin || a.origin === host)).length;
				throw new Error(
					`no peer agent on ${host}: the broker link is up, but ` +
					`that host advertises ${advertised} agent(s). Start the ` +
					`host's pi session with pi-teams so an agent registers on ` +
					`its broker, then retry.`);
			}
			const where = host ? ` on ${host}` : ` as session "${ref.session}"`;
			return {
				content: [{
					type: "text",
					text: `spawned teammate ${ref.id}${where}; call ` +
						`team_wait with id "${ref.id}" to block for its ` +
						`report.`,
				}],
				details: ref,
			};
		},
	});

	// -- agent-facing teammate attach ------------------------------------
	// Turns an existing live agent into a teammate without spawning a new
	// session: it re-registers under a fork id of this agent.
	pi.registerTool({
		name: "team_attach",
		label: "attach a teammate",
		description:
			"Attach an existing live pi agent (by id) as this agent's " +
			"teammate. The target re-registers as a fork of this agent, so " +
			"team_wait can block for its reports and the broker reaps it " +
			"when this agent goes away. An agent belongs to one team, so a " +
			"target that already has a parent is refused; a parent with no " +
			"parent of its own may be attached and become a teammate too. " +
			"Use team_spawn to create a new teammate instead.",
		parameters: Type.Object({
			target: Type.String({
				description: "Agent id to attach, from /team ls or team_wait",
			}),
			name: Type.Optional(Type.String({
				description: "Teammate name; defaults to the target's id",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const ref = await app.attach(
				params.target, params.name || "");
			if (!ref) {
				throw new Error(`could not attach ${params.target}`);
			}
			return {
				content: [{
					type: "text",
					text: `attached ${params.target} as teammate ` +
						`${ref.id}; call team_wait with id "${ref.id}" to ` +
						`block for its report.`,
				}],
				details: ref,
			};
		},
	});

	// -- agent-facing teammate wait --------------------------------------
	// An active poll: it waits for result messages while staying
	// interruptible. The run's AbortSignal (Escape) ends it at once, and
	// a queued user message makes it yield early so the steer is not
	// delayed; in both cases the report still arrives as a message.
	pi.registerTool({
		name: "team_wait",
		label: "wait for teammates",
		description:
			"Wait for teammates to report and return as soon as the first " +
			"report lands: the tool result carries every report available " +
			"at that moment, and details lists the remaining ids. " +
			"Remaining teammates keep running; their reports arrive as " +
			"pi-teams messages, or re-call team_wait with the remaining " +
			"ids to block again. While waiting the agent stays " +
			"interruptible, yields early if you queue a message, and the " +
			"tool call shows a live elapsed/pending status. Requires this " +
			"session to be a team member. Pass the ids returned by " +
			"team_spawn or team_attach.",
		promptSnippet: "Wait for teammate reports; aborts on interrupt",
		promptGuidelines: [
			"Call team_wait with the teammate ids to wait for their " +
				"reports; it returns as soon as the first report lands, " +
				"listing the still-running ids in details.remaining. If it " +
				"returns without a report, that teammate is still running " +
				"and will report as a message; re-call team_wait with the " +
				"remaining ids to keep blocking.",
		],
		parameters: Type.Object({
			id: Type.Optional(Type.String({
				description: "One teammate id returned by team_spawn",
			})),
			ids: Type.Optional(Type.Array(Type.String(), {
				description: "Several teammate ids returned by team_spawn",
			})),
			timeout: Type.Optional(Type.Number({
				description: "Seconds to wait (default PI_TEAMS_WAIT or " +
					`${DEFAULT_WAIT_SECONDS})`,
			})),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			await app.requireTeammate("team_wait");
			// A duplicated id would wait on one teammate twice; dedupe so
			// the wait's result mapping stays one entry per teammate.
			const requested = (params.ids && params.ids.length > 0)
				? params.ids
				: params.id ? [params.id] : [];
			const targetIds = [...new Set(requested)];
			if (targetIds.length === 0) {
				throw new Error("team_wait needs at least one teammate id");
			}
			const bound = waitSeconds(params.timeout);
			// Live wait status: a partial tool result the TUI re-renders
			// while the call runs, refreshed from the wait's own poll at
			// most once a second so the row is not rebuilt on every tick.
			const startedAt = Date.now();
			let lastStatus = 0;
			const updateStatus = (): void => {
				const now = Date.now();
				if (now - lastStatus < 1000) return;
				lastStatus = now;
				onUpdate?.({
					content: [{
						type: "text",
						text: `waiting for ${targetIds.length} teammate(s): ` +
							`${targetIds.join(", ")} ` +
							`(${Math.round((now - startedAt) / 1000)}s elapsed)`,
					}],
					details: undefined,
				});
			};
			// A waiting agent is not working: publish that for the whole
			// wait so the broker keeps a fork exempt from idle GC, then
			// restore the turn's busy state.
			app.setState("waiting");
			try {
				updateStatus();
				const results = await app.waitForResults(
					targetIds, bound * 1000, signal,
					() => ctx.hasPendingMessages(), updateStatus);
				const reports = results.filter(
					(message): message is TeamMessage => message !== null);
				for (const report of reports) {
					logTeamMessage(pi, "received", report);
				}
				// The first result ends the wait; the unreported ids keep
				// running and stay available for another team_wait call.
				const remaining = targetIds.filter((_id, index) =>
					results[index] === null);
				if (reports.length === 0) {
					return {
						content: [{
							type: "text",
							text: `pi-teams: no result from ` +
								`${targetIds.join(", ")} within ${bound}s; ` +
								`still running, and each will report as a message.`,
						}],
						details: { ids: targetIds, reports: [], remaining },
					};
				}
				const text = reports.map(formatReport).join("\n\n") +
					(remaining.length > 0
						? `\n\nStill waiting on ${remaining.join(", ")}; ` +
							`re-call team_wait with those ids to block again.`
						: "");
				return {
					content: [{ type: "text", text }],
					details: { ids: targetIds, reports, remaining },
				};
			} finally {
				app.setBusy(true);
			}
		},
	});

	// -- agent-facing messaging ------------------------------------------
	// Sends through the local broker, so a peer-hosted target is relayed
	// across the broker's peer link without the agent touching ssh.
	pi.registerTool({
		name: "team_send",
		label: "message an agent",
		description:
			"Send a pi-teams message to a live agent id, local or on a " +
			"linked peer host. Requires this session to be a team member " +
			"(attached or spawned), and a teammate may only message its " +
			"own team - ask your parent to attach an outsider first. The " +
			"broker relays it, so peer hosts work through the existing " +
			"peer link. Returns the broker's ack.",
		parameters: Type.Object({
			to: Type.String({ description: "Target agent id" }),
			text: Type.String({ description: "Message text" }),
			kind: Type.Optional(Type.String({
				description: "Message kind; defaults to text",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			await app.requireTeammate("team_send");
			await app.requireSameTeam(params.to);
			const reply = await app.send(
				params.to, params.kind || "text", params.text);
			return {
				content: [{
					type: "text",
					text: `sent ${params.kind || "text"} to ` +
						`${params.to}: ${reply}`,
				}],
				details: { reply },
			};
		},
	});

	pi.registerTool({
		name: "team_ls",
		label: "list agents",
		description:
			"List live pi-teams agents, including agents federated from a " +
			"linked peer host, with their id, role, and online state.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const agents = await app.snapshot();
			const peers = await app.peers();
			const lines = agents.map((a) =>
				`${a.id}\t${a.role}\t${a.online ? "online" : "offline"}` +
				(a.remote ? "\tpeer" : ""));
			const remote = agents.filter((a) => a.remote);
			const quietPeers = peers.filter(
				(p) => !remote.some((a) => a.origin === p.host));
			const body = lines.join("\n");
			const footer = quietPeers.map((p) =>
				`peer ${p.label} (${p.host}): ` +
				`${p.online ? "linked, 0 agents advertised" : "offline"} ` +
				`(start that host's pi session to federate)`);
			const parts = [body || "pi-teams: no agents registered"];
			parts.push(...footer);
			return {
				content: [{
					type: "text",
					text: `pi-teams agents:\n${parts.join("\n")}`,
				}],
				details: { agents },
			};
		},
	});

	pi.registerTool({
		name: "team_tail",
		label: "tail chat history",
		description:
			"Tail the pi chat history: returns the last lines of the most " +
			"recent session transcript (.jsonl) under the pi agent " +
			"sessions directory, so the agent can see its own conversation. " +
			"Useful to reconstruct context after a compacted, resumed, or " +
			"aborted turn.",
		parameters: Type.Object({
			lines: Type.Optional(Type.Number({
				description: "Trailing lines to return (default 60, max 500)",
			})),
		}),
		async execute(_toolCallId, params) {
			const tailer = new ChatTail(sessionsRoot);
			const lines = Math.max(1, Math.min(500, params.lines ?? 60));
			return {
				content: [{
					type: "text",
					text: tailer.tail(lines),
				}],
			};
		},
	});

	// -- cross-host peers ------------------------------------------------
	// One call links another host's broker over an existing SSH session:
	// the broker fetches the peer endpoint and owns the ssh tunnel.
	pi.registerTool({
		name: "team_peer",
		label: "link a peer host",
		description:
			"Connect another host's pi-teams broker over an existing SSH " +
			"session. add asks the broker to fetch the peer's loopback " +
			"endpoint and own the ssh tunnel, then links the two brokers " +
			"so agents can message across hosts; remove drops the link. " +
			"The peer host must already run pi-teams.",
		promptSnippet: "Link another host's pi-teams broker over SSH",
		promptGuidelines: [
			"Call team_peer add <ssh-host> once to enable cross-host " +
				"teammates. After that, team_spawn with host=<label> spawns " +
				"on that host and messages route both ways.",
			"If team_peer add reports that SSH is not usable " +
				"non-interactively, do not ask for a password: tell the user " +
				"to run the one-line setup command from the error, then retry.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("add"),
				Type.Literal("remove"),
			]),
			host: Type.String({
				description: "SSH host to reach, or an already-linked " +
					"peer label (also the default peer label)",
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
						text: `linked peer ${peer.host} (${peer.label}) ` +
							`over ssh ${params.host}; use team_spawn ` +
							`host=${peer.host} to spawn there.`,
					}],
					details: peer,
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
			"pi-teams: ls|status|send <id> [kind] <text>|attach <parent>" +
			" [name]|detach|kill <id>",
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
				if (!(await app.isTeammate())) {
					ctx.ui.notify(
						"pi-teams: /team send requires being a team member; " +
						"attach first with /team attach <parent>", "warning");
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
			if (sub === "attach") {
				const m = /^(\S+)(?:\s+(\S+))?$/.exec(rest);
				if (!m || !m[1]) {
					ctx.ui.notify("usage: /team attach <parent> [name]",
						"warning");
					return;
				}
				if (app.hasParent()) {
					ctx.ui.notify(
						"pi-teams: already a teammate; an agent belongs " +
						"to one team (detach first)", "warning");
					return;
				}
				const ref = await app.attachTo(m[1], m[2] || "");
				ctx.ui.notify(
					`pi-teams: attached as teammate ${ref.id}`, "info");
				return;
			}
			if (sub === "detach") {
				const id = app.detach();
				ctx.ui.notify(`pi-teams: detached; now ${id}`, "info");
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
					"<text> | attach <parent> [name] | detach | kill <id>",
				"warning",
			);
		},
	});
}
