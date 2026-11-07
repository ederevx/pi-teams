/**
 * pi-teams onboarding: the `pre_teams` catalog tool.
 *
 * The team tools are useless to a model that does not know they exist or
 * how they behave, while the surfaces that used to say so (prompt
 * snippets, long tool descriptions, the injected teammates note) bloated
 * every session's prompt. `pre_teams` now owns that knowledge: one call
 * returns the tool catalog, the conventions, and the feature summary.
 *
 * It is also the gate: until `pre_teams` has been called in a session,
 * every other tool this extension registers is blocked with a reason
 * pointing here. Non-extension tools are never touched. The gate resets
 * on each session start. Tool rows use pi's native collapsed rendering,
 * so the extension blends in; Ctrl+O expands.
 */

import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The name of this extension's onboarding tool. */
const TOOL_NAME = "pre_teams";

/** One registered team tool and its one-line purpose. */
interface CatalogTool {
	readonly name: string;
	readonly purpose: string;
}

/** Owns the `pre_teams` tool, its first-call gate, and the collapse
 *  default. One instance per extension runtime. */
export class PreTeamsTool {
	private readonly tools: readonly CatalogTool[];
	private readonly conventions: readonly string[];
	private readonly features: readonly string[];
	/** The tool names this extension registers and therefore gates.
	 *  `pre_teams` is deliberately absent: it is the way in. */
	private readonly owned: ReadonlySet<string>;
	private acknowledged = false;

	constructor() {
		this.tools = [
			{
				name: "team_spawn",
				purpose: "start a new, blank teammate for one " +
					"self-contained task; only when no live session " +
					"already fits.",
			},
			{
				name: "team_wait",
				purpose: "block for the first teammate report; the rest " +
					"keep running.",
			},
			{
				name: "team_send",
				purpose: "message a live agent, local or on a linked " +
					"peer; hands an existing session its task.",
			},
			{
				name: "team_ls",
				purpose: "list live agents (id, role, name, cwd, " +
					"parent) and linked peers.",
			},
			{
				name: "team_peek",
				purpose: "read a local agent's transcript by id " +
					"(default yours): head/tail pages, grep with " +
					"context; prints the .jsonl path for read.",
			},
			{
				name: "team_peer",
				purpose: "link or unlink a peer host's broker over SSH.",
			},
			{
				name: "team_kill",
				purpose: "terminate a spawned fork by id; a session a " +
					"user started is refused.",
			},
			{
				name: "team_gc_reap",
				purpose: "acknowledge the broker's idle reap and shut down.",
			},
		];
		this.owned = new Set(this.tools.map((tool) => tool.name));
		this.conventions = [
			"Call pre_teams once per session before any team tool; its " +
				"gate blocks the rest until you do.",
			"Work a live session already holds is that session's: run " +
				"team_ls, then team_peek likely candidates - from=head shows " +
				"the task, grep finds the topic, tail shows where it " +
				"stopped - and send the session that fits the task's topic, " +
				"repo, or files.",
			"Reuse chain: team_ls -> team_peek -> team_send the session " +
				"its task and where to send the result (kind=result) -> " +
				"team_wait on that id. Nothing is reserved: the session may " +
				"take other work meanwhile, so name the destination.",
			"During an active task, route incoming work separately if it " +
				"requests a separate deliverable or requires a repo/file set " +
				"or target system outside what the current deliverable " +
				"requires. This applies to team_send tasks, user prompts, " +
				"and reports that request new work. Another step toward the " +
				"same deliverable, a follow-up confined to its existing files " +
				"and system, or a report on delegated work is not a scope " +
				"change. An explicit replacement or cancellation changes the " +
				"current task instead.",
			"Route separate work immediately: team_ls -> team_peek -> " +
				"team_send to a live session that already owns that scope and " +
				"can take it; otherwise team_spawn one self-contained task. " +
				"Give it an explicit result destination, tell the requester " +
				"the owning session id, and keep the current task on its " +
				"scope. The parent retains planning, integration, and final " +
				"validation. Use team_wait when needed; re-call it with " +
				"details.remaining to keep blocking, or keep working and " +
				"receive the report as a message.",
			"A teammate silent past the stall bound is nudged once per " +
				"wait (PI_TEAMS_STALL, 0 disables).",
			"The parent owns planning, integration, and final validation. " +
				"Every registered session is addressable, local or on a " +
				"linked peer.",
			"Rebuild your own context after compaction or a resume with " +
				"team_peek and no target: tail it, or grep a keyword.",
			"team_peek reads local transcripts only; a peer-hosted " +
				"agent is still reachable by team_send, judged by its " +
				"team_ls name.",
			"Call team_gc_reap only when the broker asks or this session " +
				"is done.",
			"Work on another host stays in pi-teams: ssh is for moving " +
				"files (scp, sftp, rsync), and headless pi is refused; the " +
				"remote-work guard blocks both.",
		];
		this.features = [
			"A local broker registers every pi session and relays " +
				"messages between them.",
			"Spawned teammates are persistent, resumable child sessions " +
				"that inherit the current model and thinking level and " +
				"reap themselves when idle.",
			"Sending presents the session's own send token, so a message " +
				"speaks for its sender; every registered agent is " +
				"reachable, and only a spawned fork can be killed.",
			"team_peek reads the transcript the broker registered for an " +
				"agent id, never just the newest file; its #N lines map to " +
				"the read tool.",
			"team_peer links another host over SSH; /team-ls opens the " +
				"dock and /team-settings edits the piTeams settings.",
		];
	}

	/** Register the tool, the first-call gate, and the collapse default. */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: TOOL_NAME,
			label: TOOL_NAME,
			description:
				"Call this once before using any pi-teams tool in a " +
				"session. Returns the pi-teams tool catalog, conventions, " +
				"and feature summary.",
			promptSnippet:
				"List pi-teams tools, conventions, and features " +
				"(call once per session)",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			execute: async () => {
				this.acknowledged = true;
				return {
					content: [{ type: "text", text: this.catalog() }],
					details: {
						tools: this.tools.map((tool) => tool.name),
						conventions: this.conventions,
						features: this.features,
					},
				};
			},
		});
		pi.on("session_start", async () => {
			this.beginSession();
		});
		pi.on("tool_call", (event) => this.gate(event));
	}

	/** The model-facing catalog: tools, then conventions, then features. */
	catalog(): string {
		const tools = this.tools.map((tool) =>
			`- ${tool.name}: ${tool.purpose}`);
		return [
			`${TOOL_NAME} - pi-teams catalog (call again any time)`,
			"",
			"Tools:",
			`- ${TOOL_NAME}: this catalog; call once before any team tool.`,
			...tools,
			"",
			"Conventions:",
			...this.conventions.map((line) => `- ${line}`),
			"",
			"Features:",
			...this.features.map((line) => `- ${line}`),
		].join("\n");
	}

	/** True only for the tools this extension registers. */
	owns(name: string): boolean {
		return this.owned.has(name);
	}

	/** Reset per-session acknowledgement. */
	private beginSession(): void {
		this.acknowledged = false;
	}

	/** Block this extension's tools until `pre_teams` has been called;
	 *  never touch any other tool. */
	private gate(event: ToolCallEvent): ToolCallEventResult | undefined {
		const name = String(event.toolName ?? "");
		if (name === TOOL_NAME) {
			this.acknowledged = true;
			return undefined;
		}
		if (!this.acknowledged && this.owns(name)) {
			return {
				block: true,
				reason:
					"Call pre_teams first: it returns the pi-teams tool " +
					"catalog and conventions. Then retry this call.",
			};
		}
		return undefined;
	}
}
