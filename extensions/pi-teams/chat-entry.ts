/**
 * One pi transcript entry (.jsonl line), parsed and rendered to its
 * role-labelled text form. Shared by the paged reader (ChatPeek) and the
 * live team_wait stream, so a session's conversation reads the same way
 * wherever it is shown.
 */

export type PeekKind =
	"user" | "assistant" | "thinking" | "tool" | "summary" | "custom" |
	"meta";

type Json = Record<string, unknown>;

/** One rendered entry: the include-kind it belongs to, its label, and
 *  the full text (clipping belongs to the caller). */
export interface RenderedEntry {
	kind: PeekKind;
	label: string;
	full: string;
}

export class ChatEntryRenderer {
	static readonly KINDS: readonly PeekKind[] = [
		"user", "assistant", "thinking", "tool", "summary", "custom", "meta",
	];
	static readonly DEFAULT_KINDS: readonly PeekKind[] = [
		"user", "assistant", "summary", "custom",
	];

	parse(line: string): Json | null {
		try {
			const value = JSON.parse(line);
			return value && typeof value === "object"
				? value as Json : null;
		} catch {
			return null;
		}
	}

	render(
		entry: Json | null,
		line: string,
		include: ReadonlySet<PeekKind>,
	): RenderedEntry | null {
		if (!entry) {
			return {
				kind: "meta", label: "unparsed", full: line.slice(0, 500),
			};
		}
		if (entry.type === "message") {
			const message = (entry.message ?? {}) as Json;
			const role = String(message.role ?? "");
			const full = this.flatten(message.content, include).trim();
			if (!full) return null;
			if (role === "user" || role === "assistant") {
				return { kind: role, label: role, full };
			}
			if (role === "toolResult") {
				const name = String(message.toolName ?? "");
				const error = message.isError ? " error" : "";
				return {
					kind: "tool",
					label: `tool ${name}${error}`.trim(),
					full,
				};
			}
			if (role === "system") {
				return { kind: "meta", label: "system", full };
			}
			return { kind: "custom", label: role || "message", full };
		}
		if (entry.type === "custom_message") {
			const full = this.flatten(entry.content, include).trim();
			if (!full) return null;
			return {
				kind: "custom",
				label: `custom ${String(entry.customType ?? "")}`.trim(),
				full,
			};
		}
		if (typeof entry.summary === "string") {
			return {
				kind: "summary",
				label: String(entry.type),
				full: entry.summary,
			};
		}
		return {
			kind: "meta",
			label: String(entry.type ?? "entry"),
			full: JSON.stringify(entry).slice(0, 300),
		};
	}

	private flatten(content: unknown, include: ReadonlySet<PeekKind>): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((block) => this.block((block ?? {}) as Json, include))
			.filter((text) => text.length > 0)
			.join("\n");
	}

	private block(block: Json, include: ReadonlySet<PeekKind>): string {
		switch (block.type) {
		case "text":
			return String(block.text ?? "");
		case "thinking":
			return include.has("thinking")
				? `[thinking] ${String(block.thinking ?? "")}`
				: "";
		case "toolCall":
			return `[call ${String(block.name ?? "")} ` +
				`${JSON.stringify(block.arguments ?? {}).slice(0, 200)}]`;
		case "toolResult":
			return this.flatten(block.content, include);
		case "image":
			return "[image]";
		default:
			return "";
		}
	}
}
