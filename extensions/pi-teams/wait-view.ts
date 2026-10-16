/**
 * pi-teams - the TUI view of a team_wait result.
 *
 * A live wait shows one section per teammate - a bold header marker,
 * then its activity colored by kind - so every stream stays in view
 * and a marker never reads as another output line. The final
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
import { WaitLinePalette } from "./wait-palette.ts";

/** The part of pi's render context this view reads. */
export interface ResultRenderSlot {
	lastComponent: Component | undefined;
}

export class TeamWaitView {
	private static readonly PARTIAL_LINES = 12;
	private static readonly PREVIEW_LINES = 10;
	private readonly palette = new WaitLinePalette();

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
			? this.streamLines(result, options.expanded, theme)
			: this.resultLines(result, options.expanded, theme);
		return lines.join("\n");
	}

	/** One section per teammate: a bold marker, then that teammate's
	 *  activity colored by kind, so the marker never reads as just
	 *  another line of output. */
	private streamLines(
		result: AgentToolResult<unknown>,
		expanded: boolean,
		theme: Theme,
	): string[] {
		const streams = this.streams(result);
		if (streams.length === 0) return this.plainLines(result, theme);
		const perStream = Math.max(
			1, Math.floor(TeamWaitView.PARTIAL_LINES / streams.length) - 1);
		const lines: string[] = [];
		for (const stream of streams) {
			lines.push(this.marker(stream, theme));
			const shown = expanded
				? stream.lines : stream.lines.slice(-perStream);
			if (shown.length === 0) {
				lines.push(theme.fg("dim", "(no activity yet)"));
				continue;
			}
			for (const line of shown) lines.push(this.activity(line, theme));
		}
		return lines;
	}

	/** A section header: the teammate's id in the title color, its state
	 *  muted, framed by rules. */
	private marker(stream: TeamWaitStreamSection, theme: Theme): string {
		return theme.fg("toolTitle", theme.bold(`── ${stream.id}`)) +
			theme.fg("muted", ` (${stream.state}) `) +
			theme.fg("toolTitle", "──");
	}

	/** One activity line, colored by its `[label]` kind; text keeps the
	 *  line's own color so it never reads as the marker above it. */
	private activity(line: string, theme: Theme): string {
		const labelled = /^\[([^\]]+)\]\s?(.*)$/.exec(line);
		if (!labelled) return theme.fg(this.palette.plain().text, line);
		const tone = this.palette.tone(labelled[1]);
		const body = theme.fg(tone.text, labelled[2]);
		return `${theme.fg(tone.label, `[${labelled[1]}]`)} ` +
			(tone.italic ? theme.italic(body) : body);
	}

	private resultLines(
		result: AgentToolResult<unknown>,
		expanded: boolean,
		theme: Theme,
	): string[] {
		const styled = this.plainLines(result, theme);
		if (expanded || styled.length <= TeamWaitView.PREVIEW_LINES) return styled;
		const hidden = styled.length - TeamWaitView.PREVIEW_LINES;
		return [
			...styled.slice(0, TeamWaitView.PREVIEW_LINES),
			theme.fg("muted",
				`... (${hidden} more lines; expand the tool to show all)`),
		];
	}

	/** The result text, line by line, in the output color. */
	private plainLines(
		result: AgentToolResult<unknown>,
		theme: Theme,
	): string[] {
		return this.plainText(result).split("\n")
			.map((line) => theme.fg("toolOutput", line));
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
