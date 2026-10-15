/**
 * pi-teams - the TUI view of a team_wait result.
 *
 * A live wait shows one section per teammate - its state and most recent
 * lines - so every stream stays in view while the wait blocks. The final
 * result is pi's own preview: the first lines, with the rest on expand.
 * Used only by the interactive renderer, so the model-facing text is
 * untouched.
 */

import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

import type { TeamWaitStreamSection } from "./wait-feed.ts";

/** The part of pi's render context this view reads. */
export interface ResultRenderSlot {
	lastComponent: Component | undefined;
}

export class TeamWaitView {
	private static readonly PARTIAL_LINES = 12;
	private static readonly PREVIEW_LINES = 10;

	/** Renders one result into a reusable Text component. */
	render(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		slot: ResultRenderSlot,
	): Component {
		const component = slot.lastComponent instanceof Text
			? slot.lastComponent : new Text("", 0, 0);
		component.setText(this.body(result, options, theme));
		return component;
	}

	private body(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
	): string {
		const lines = options.isPartial
			? this.streamLines(result, options.expanded)
			: this.resultLines(result, options.expanded);
		return lines.map((line) => theme.fg("toolOutput", line)).join("\n");
	}

	private streamLines(
		result: AgentToolResult<unknown>,
		expanded: boolean,
	): string[] {
		const streams = this.streams(result);
		if (streams.length === 0) return this.plainText(result).split("\n");
		const perStream = Math.max(
			1, Math.floor(TeamWaitView.PARTIAL_LINES / streams.length) - 1);
		const lines: string[] = [];
		for (const stream of streams) {
			lines.push(`── ${stream.id} (${stream.state}) ──`);
			const shown = expanded
				? stream.lines : stream.lines.slice(-perStream);
			lines.push(...(shown.length > 0 ? shown : ["(no activity yet)"]));
		}
		return lines;
	}

	private resultLines(
		result: AgentToolResult<unknown>,
		expanded: boolean,
	): string[] {
		const lines = this.plainText(result).split("\n");
		if (expanded || lines.length <= TeamWaitView.PREVIEW_LINES) return lines;
		const hidden = lines.length - TeamWaitView.PREVIEW_LINES;
		return [
			...lines.slice(0, TeamWaitView.PREVIEW_LINES),
			`... (${hidden} more lines; expand the tool to show all)`,
		];
	}

	private streams(result: AgentToolResult<unknown>): TeamWaitStreamSection[] {
		const details = result.details as
			{ streams?: TeamWaitStreamSection[] } | undefined;
		return details?.streams ?? [];
	}

	private plainText(result: AgentToolResult<unknown>): string {
		return result.content
			.filter((block): block is { type: "text"; text: string } =>
				block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
}
