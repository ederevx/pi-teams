/**
 * pi-teams - cross-pi-agent communication and self-forks.
 *
 * Registers the running pi process with the team broker through a held
 * connection (an endpoint other agents can reach), injects a pre-turn
 * awareness note, and registers the team tools, events, and command.
 * Thin entry: the modules under ./pi-teams/ carry the responsibilities
 * (not auto-discovered - the subdirectory has no index.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { TeamAgent } from "./pi-teams/agent.ts";
import { ChatTail } from "./pi-teams/chat-tail.ts";
import { openTeammatesDock } from "./pi-teams/dock.ts";
import {
	announceAgents,
	deliverToAgent,
	formatReport,
	logTeamMessage,
	registerLogRenderer,
} from "./pi-teams/messages.ts";
import { sessionsRoot } from "./pi-teams/paths.ts";
import { ProcessRunner } from "./pi-teams/process-runner.ts";
import { TeamSettingsPresenter } from "./pi-teams/settings-presenter.ts";
import {
	DEFAULT_STALL_SECONDS,
	DEFAULT_WAIT_SECONDS,
	stallSeconds,
	waitSeconds,
	type TeamMessage,
} from "./pi-teams/protocol.ts";

// Re-exported so tests and embedders reach the seam classes from the
// entry alone.
export { TeamAgent } from "./pi-teams/agent.ts";
export { ChatTail } from "./pi-teams/chat-tail.ts";
export { ProcessRunner } from "./pi-teams/process-runner.ts";
export {
	WindowlessPython,
	windowlessCandidates,
} from "./pi-teams/interpreter.ts";
export { logTeamMessage };
export { AgentDirectory } from "./pi-teams/directory.ts";
export { ResultInbox } from "./pi-teams/inbox.ts";
export { PendingRequests } from "./pi-teams/pending.ts";
export { BrokerOps } from "./pi-teams/broker-ops.ts";
export { SpawnService } from "./pi-teams/spawn.ts";

export default async function (pi: ExtensionAPI) {
	// A reload builds a second TeamAgent while the first one's hold may
	// still be registered (two ids, one session). Hand over: the fresh
	// instance inherits the live identity; the previous one stops
	// holding without a resurrect.
	const holder = globalThis as unknown as {
		__piTeamsAgent?: TeamAgent;
	};
	const previous = holder.__piTeamsAgent;
	if (previous) previous.handover();
	const app = new TeamAgent(
		new ProcessRunner(),
		(message) => deliverToAgent(pi, message),
	);
	if (previous) app.inheritIdentity(previous);
	holder.__piTeamsAgent = app;

	registerLogRenderer(pi);

	// -- agent-facing teammate spawn -------------------------------------
	// The agent names a task and gets a resumable session back; no
	// wrapper script or command line is needed.
	const { Type } = await import("typebox");
	pi.registerTool({
		name: "team_spawn",
		label: "spawn teammate",
		description:
			"Spawn a teammate: a persistent, resumable pi session that " +
			"reports back as a team message. One task each; wait with " +
			"team_wait or let the report arrive on its own. The " +
			"teammate starts with a clean context, receives only the " +
			"task, and runs with the general teammate role (reports, " +
			"messages, waits, leads its own sub-team, no memory).",
		promptSnippet:
			"Spawn a pi-teams teammate to do a task in its own session",
		promptGuidelines: [
			"Delegate bounded tasks: pass one self-contained task per " +
				"team_spawn, then call team_wait to block for the report " +
				"or keep working and let it arrive as a message.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The task the teammate must do" }),
			name: Type.Optional(Type.String({
				description: "Teammate and session name",
			})),
			host: Type.Optional(Type.String({
				description: "Peer host to spawn on; default this host",
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
				if (advertised === 0) {
					throw new Error(
						`no peer agent on ${host}: the link is up but that ` +
						`host advertises no agents. Start its pi session ` +
						`with pi-teams so one registers, then retry.`);
				}
				throw new Error(
					`spawn on ${host} timed out or was refused by all ` +
					`${advertised} advertised agent(s) (no answer within ` +
					`15s, or spawn-error). Check that the host's main pi ` +
					`session is responsive, then retry.`);
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
	// Makes an existing live agent a teammate without a new session:
	// it re-registers under a fork id of this agent.
	pi.registerTool({
		name: "team_attach",
		label: "attach a teammate",
		description:
			"Attach an existing live pi agent (by id) as your teammate. " +
			"It re-registers as your fork, so team_wait blocks for its " +
			"reports and the broker reaps it with you (exempt from " +
			"fork-idle GC while you stay connected). One team per agent: " +
			"a target with a parent is refused, and a teammate cannot " +
			"attach (a root runs the attach). Use team_spawn for a new " +
			"teammate instead.",
		parameters: Type.Object({
			target: Type.String({
				description: "Agent id to attach (from /team-ls)",
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
	// An active poll that stays interruptible (Escape ends it at once,
	// a queued message yields early); the report arrives either way.
	pi.registerTool({
		name: "team_wait",
		label: "wait for teammates",
		description:
			"Wait for teammates to report; returns on the first report " +
			"(details lists remaining ids, which keep running and " +
			"report as messages). While waiting the agent stays " +
			"interruptible, yields early on a queued message, and the " +
			"call shows live elapsed/pending status. A teammate silent " +
			`past the stall bound is nudged once (PI_TEAMS_STALL or ` +
			`${DEFAULT_STALL_SECONDS}s; 0 disables). Requires team ` +
			"membership; ids come from team_spawn or team_attach.",
		promptSnippet: "Wait for teammate reports; aborts on interrupt",
		promptGuidelines: [
			"team_wait returns the first report; re-call it with " +
				"details.remaining to keep blocking. Silent teammates " +
				"are nudged automatically once per wait.",
		],
		parameters: Type.Object({
			id: Type.Optional(Type.String({
				description: "One teammate id from team_spawn",
			})),
			ids: Type.Optional(Type.Array(Type.String(), {
				description: "Several teammate ids from team_spawn",
			})),
			timeout: Type.Optional(Type.Number({
				description: "Seconds to wait (default PI_TEAMS_WAIT or " +
					`${DEFAULT_WAIT_SECONDS})`,
			})),
			stall: Type.Optional(Type.Number({
				description: "Seconds of teammate silence before the " +
					`auto-nudge (PI_TEAMS_STALL or ${DEFAULT_STALL_SECONDS}; ` +
					"0 disables)",
			})),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			await app.requireTeammate("team_wait");
			// Dedupe: a duplicated id would wait on one teammate twice.
			const requested = (params.ids && params.ids.length > 0)
				? params.ids
				: params.id ? [params.id] : [];
			const targetIds = [...new Set(requested)];
			if (targetIds.length === 0) {
				throw new Error("team_wait needs at least one teammate id");
			}
			const bound = waitSeconds(params.timeout);
			// Live wait status: a partial result the TUI re-renders
			// while the call runs, at most once a second.
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
			// A waiting agent is not working: publish that for the
			// whole wait (the fork stays exempt from idle GC), then
			// restore the turn's busy state.
			app.setState("waiting");
			try {
				updateStatus();
				// Watch the wait for a hung teammate: past the stall bound
				// the wait itself sends the continue-or-report steer, once
				// per teammate, instead of blocking silently forever.
				const stallMs = stallSeconds(params.stall) * 1000;
				const results = await app.waitForResults(
					targetIds, bound * 1000, signal,
					() => ctx.hasPendingMessages(), updateStatus, stallMs);
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
	// Sends through the local broker: a peer-hosted target is relayed
	// over the peer link, no ssh in the extension.
	pi.registerTool({
		name: "team_send",
		label: "message an agent",
		description:
			"Send a pi-teams message to a live agent id, local or " +
			"peer-hosted (relayed over the peer link). Teammates " +
			"message only their own team - ask your parent to attach " +
			"an outsider first. Returns the broker's ack.",
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
			"List live pi-teams agents (id, role, online state), " +
			"including peer-host agents.",
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
			"Tail the pi chat history: the last lines of the newest " +
			"session transcript (.jsonl), to reconstruct context after " +
			"a compacted, resumed, or aborted turn.",
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
	// Links another host's broker over an existing SSH session: the
	// broker fetches the peer endpoint and owns the tunnel.
	pi.registerTool({
		name: "team_peer",
		label: "link a peer host",
		description:
			"Link another host's pi-teams broker over an existing SSH " +
			"session (add links it and owns the ssh tunnel; remove " +
			"drops the link) so agents can message across hosts. The " +
			"peer host must already run pi-teams.",
		promptSnippet: "Link another host's pi-teams broker over SSH",
		promptGuidelines: [
			"team_peer add <ssh-host> once enables cross-host teammates " +
				"(team_spawn host=<label>); if SSH is not usable " +
				"non-interactively, have the user run the one-line setup " +
				"command from the error, then retry.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("add"),
				Type.Literal("remove"),
			]),
			host: Type.String({
				description: "SSH host or linked peer label",
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
				content: [{ type: "text",
					text: `unlinked peer ${params.host}` }],
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
		const note = announceAgents(agents);
		if (note) return { message: note };
	});

	pi.on("session_shutdown", async () => {
		app.deregister();
	});

	pi.registerCommand("team-ls", {
		description:
			"pi-teams: open the teammates dock (live teammates, " +
			"settings-style layout, last-active times). Read-only; " +
			"acting on a teammate is a tool call.",
		handler: async (_args, ctx) => {
			const agents = await app.snapshot();
			await openTeammatesDock(agents, ctx);
		},
	});

	// -- settings editor ------------------------------------------------
	// Every piTeams value as an editable row; a change is written to the
	// agent-directory settings.json, which pi reloads extensions from.
	const settingsPresenter = new TeamSettingsPresenter();
	pi.registerCommand("team-settings", {
		description: "Edit pi-teams settings",
		handler: async (_args, ctx) => {
			try {
				await settingsPresenter.present(
					ctx.ui, ctx.mode, settingsPresenter.changeHandler(ctx.ui));
			} catch {
				console.error("pi-teams: could not render settings");
			}
		},
	});

	// -- agent-facing teammate detach -------------------------------------
	// Returns an attached session to a plain main agent.
	pi.registerTool({
		name: "team_detach",
		label: "detach from team",
		description:
			"Return this session to a plain main agent when it was a " +
			"teammate: the fork identity is dropped, so the parent can " +
			"no longer wait on or reap it. A root (no parent) is refused.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!app.hasParent()) {
				throw new Error(
					"team_detach needs an attached session; this " +
					"session is a team root");
			}
			const id = app.detach();
			return {
				content: [{
					type: "text",
					text: `detached; this session is now ${id}`,
				}],
				details: { id },
			};
		},
	});

	// -- agent-facing teammate termination ---------------------------------
	// Ends a teammate like the broker GC would, session file included.
	pi.registerTool({
		name: "team_kill",
		label: "terminate a teammate",
		description:
			"Terminate a pi-teams agent by id, local or peer-hosted " +
			"(routed through the link): its process is signalled and " +
			"its session file removed. Requires team membership.",
		promptSnippet: "Terminate a teammate by id",
		parameters: Type.Object({
			target: Type.String({
				description: "Agent id to terminate",
			}),
			why: Type.Optional(Type.String({
				description: "Why it is terminated; recorded in the log",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			await app.requireTeammate("team_kill");
			await app.terminate(params.target);
			return {
				content: [{
					type: "text",
					text: `terminated ${params.target}`,
				}],
				details: { target: params.target },
			};
		},
	});
}
