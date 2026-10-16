/**
 * pi-teams - the color a live wait line takes from the kind behind it.
 *
 * `ChatEntryRenderer` labels every streamed transcript line, so the label
 * picks the tone of both the `[label]` prefix and the text. Color now
 * carries the kind and the marker keeps its own bold title token, so no
 * activity line needs the indent that used to set it apart from a marker.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** One line's colors: the label's token, the text's token, and whether
 *  the text is italicized (a kind without an author's voice). */
export interface WaitLineTone {
	label: ThemeColor;
	text: ThemeColor;
	italic: boolean;
}

export class WaitLinePalette {
	private static readonly PLAIN: WaitLineTone = {
		label: "toolTitle", text: "toolOutput", italic: false,
	};

	/** The tone for a line labelled by `ChatEntryRenderer`. */
	tone(label: string): WaitLineTone {
		if (label === "user") {
			return { label: "accent", text: "accent", italic: false };
		}
		if (label === "assistant") {
			return { label: "success", text: "text", italic: false };
		}
		if (label.startsWith("tool ")) {
			return label.endsWith(" error")
				? { label: "error", text: "error", italic: false }
				: { label: "toolTitle", text: "toolOutput", italic: false };
		}
		if (label === "custom" || label.startsWith("custom ")) {
			return {
				label: "customMessageLabel",
				text: "customMessageText",
				italic: false,
			};
		}
		return { label: "thinkingText", text: "thinkingText", italic: true };
	}

	/** The tone for a line with no label. */
	plain(): WaitLineTone {
		return WaitLinePalette.PLAIN;
	}
}
