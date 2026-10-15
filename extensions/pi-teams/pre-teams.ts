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
				name: "team_attach",
				purpose: "make an existing live agent your teammate, " +
					"keeping its context; prefer it over team_spawn when " +
					"that session already works on the topic.",
			},
			{
				name: "team_wait",
				purpose: "block for the first teammate report; the rest " +
					"keep running.",
			},
			{
				name: "team_send",
				purpose: "message a live agent, local or on a linked " +
					"peer; gives an attached teammate its task.",
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
				name: "team_detach",
				purpose: "return an attached session to a plain main agent.",
			},
			{
				name: "team_kill",
				purpose: "terminate an agent by id.",
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
			"Reuse before you spawn: run team_ls, then team_peek likely " +
				"candidates - from=head shows the original task, grep " +
				"finds the topic, tail shows where it stopped.",
			"Prefer team_attach when a live session's history already " +
				"covers the task's topic, repo, or files: it keeps that " +
				"context, while a spawn starts blank. Spawn only when none " +
				"fits or every fit already has a parent (attach refuses " +
				"those).",
			"Attach chain: team_attach an id -> team_send the returned " +
				"teammate id the task (attaching hands over no task) -> " +
				"team_wait on that id.",
			"Spawn chain: team_spawn one self-contained task -> " +
				"team_wait, or keep working and take the report as a " +
				"message.",
			"Re-call team_wait with details.remaining to keep blocking; " +
				"an unwaited report still arrives as a message.",
			"A teammate silent past the stall bound is nudged once per " +
				"wait (PI_TEAMS_STALL, 0 disables).",
			"The parent owns planning, integration, and final validation. " +
				"A teammate messages only its own team and asks its parent " +
				"to attach an outsider.",
			"An orphaned teammate - its parent no longer live - is " +
				"independent: it acts as its own team root, so it keeps " +
				"messaging and may become a plain agent with team_detach.",
			"Rebuild your own context after compaction or a resume with " +
				"team_peek and no target: tail it, or grep a keyword.",
			"team_peek reads local transcripts only; a peer-hosted " +
				"agent can still be attached, judged by its team_ls name.",
			"Call team_gc_reap only when the broker asks or this session " +
				"is done.",
		];
		this.features = [
			"A local broker registers every pi session and relays " +
				"messages between them.",
			"Spawned teammates are persistent, resumable child sessions " +
				"that inherit the current model and thinking level and " +
				"reap themselves when idle.",
			"Sending and waiting are member-only; the broker enforces it " +
				"with a per-session send token.",
			"A teammate's transcript marks it a member even after its " +
				"launch env is lost; orphaned, it becomes its own team root.",
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
