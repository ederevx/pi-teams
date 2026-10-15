/**
 * Peek at one pi transcript (.jsonl): role-labelled entries from its
 * head or tail, paged, or grep matches with context. One
 * responsibility - showing an agent a session's conversation, its own
 * or another local agent's. The file is streamed in one pass and only
 * the requested page is kept, so a large transcript stays bounded.
 */

import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

export type PeekKind =
	"user" | "assistant" | "thinking" | "tool" | "summary" | "custom" |
	"meta";

export interface PeekQuery {
	from: "head" | "tail";
	limit: number;
	offset: number;
	grep: RegExp | null;
	context: number;
	include: ReadonlySet<PeekKind>;
	maxChars: number;
}

/** One rendered entry; `line` is the 1-based JSONL line (read offset),
 *  `seq` its ordinal among included entries (dedupes grep context). */
export interface PeekEntry {
	line: number;
	seq: number;
	label: string;
	text: string;
}

export interface PeekPage {
	cwd: string;
	scanned: number;
	/** Entries, or grep matches, in the whole file. */
	units: number;
	/** The requested units in file order; a grep unit carries context. */
	page: PeekEntry[][];
	more: boolean;
}

interface Rendered {
	kind: PeekKind;
	label: string;
	full: string;
}

type Json = Record<string, unknown>;

export class ChatPeek {
	static readonly KINDS: readonly PeekKind[] = [
		"user", "assistant", "thinking", "tool", "summary", "custom", "meta",
	];
	static readonly DEFAULT_KINDS: readonly PeekKind[] = [
		"user", "assistant", "summary", "custom",
	];
	static readonly OUTPUT_CAP = 50_000;
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	/** A case-insensitive pattern; an invalid regex matches literally. */
	static pattern(source: string): RegExp {
		try {
			return new RegExp(source, "i");
		} catch {
			return new RegExp(
				source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
		}
	}

	async read(query: PeekQuery): Promise<PeekPage> {
		this.requireTranscript();
		const keep = query.offset + query.limit;
		const stored: PeekEntry[][] = [];
		const before: PeekEntry[] = [];
		let pending: { unit: PeekEntry[]; left: number }[] = [];
		let cwd = "";
		let scanned = 0;
		let seq = 0;
		let units = 0;
		const store = (unit: PeekEntry[]): void => {
			const index = units++;
			if (query.from === "head") {
				if (index < query.offset || index >= keep) return;
				stored.push(unit);
			} else {
				stored.push(unit);
				if (stored.length > keep) stored.shift();
			}
			if (query.grep && query.context > 0) {
				pending.push({ unit, left: query.context });
			}
		};
		const lines = createInterface({
			input: createReadStream(this.path, "utf8"),
			crlfDelay: Infinity,
		});
		for await (const line of lines) {
			scanned++;
			if (!line.trim()) continue;
			const parsed = this.parse(line);
			if (parsed?.type === "session" && !cwd) {
				cwd = String(parsed.cwd ?? "");
			}
			const rendered = this.render(parsed, line, query.include);
			if (!rendered || !query.include.has(rendered.kind)) continue;
			// Match the full text, then keep only a clipped copy.
			const hit = query.grep ? rendered.full.search(query.grep) : 0;
			const entry: PeekEntry = {
				line: scanned,
				seq: ++seq,
				label: rendered.label,
				text: this.clip(rendered.full, query.maxChars, Math.max(0, hit)),
			};
			for (const open of pending) {
				open.unit.push(entry);
				open.left--;
			}
			pending = pending.filter((open) => open.left > 0);
			if (!query.grep) {
				store([entry]);
				continue;
			}
			if (hit >= 0) store([...before, entry]);
			before.push(entry);
			if (before.length > query.context) before.shift();
		}
		const page = query.from === "head"
			? stored
			: stored.slice(0, Math.max(0, stored.length - query.offset));
		return { cwd, scanned, units, page, more: units > keep };
	}

	/** The model-facing page: header, rows, paging and cap notes. */
	format(result: PeekPage, query: PeekQuery, target: string): string {
		const noun = query.grep ? "matches" : "entries";
		const rows: string[] = [];
		let last = 0;
		for (const unit of result.page) {
			for (const entry of unit) {
				if (entry.seq <= last) continue;
				if (query.grep && last > 0 && entry.seq > last + 1) {
					rows.push("--");
				}
				rows.push(`#${entry.line} ${entry.label}: ` +
					entry.text.replace(/\n/g, "\n  "));
				last = entry.seq;
			}
		}
		let size = rows.reduce((n, row) => n + row.length + 1, 0);
		let cut = 0;
		while (rows.length > 1 && size > ChatPeek.OUTPUT_CAP) {
			const row = query.from === "tail" ? rows.shift() : rows.pop();
			size -= (row ?? "").length + 1;
			cut++;
		}
		if (rows[0] === "--") rows.shift();
		if (rows.at(-1) === "--") rows.pop();
		if (rows.length === 0) {
			rows.push(query.grep
				? "(no matches)" : "(no entries of these kinds)");
		}
		const notes: string[] = [];
		if (result.more) {
			notes.push(`more: offset=${query.offset + query.limit} for ` +
				`${query.from === "tail" ? "older" : "newer"} ${noun}`);
		}
		if (cut > 0) {
			notes.push(`output capped at ${ChatPeek.OUTPUT_CAP} chars ` +
				`(${cut} rows dropped): lower limit or maxChars`);
		}
		return [
			`team_peek ${target}: ${this.path}`,
			`${result.cwd ? `cwd ${result.cwd}; ` : ""}${query.from} ` +
				(query.grep ? `grep /${query.grep.source}/i, ` : "") +
				`${result.page.length} of ${result.units} ${noun} at ` +
				`offset ${query.offset}; kinds ` +
				`${[...query.include].join(",")}; #N is the JSONL line ` +
				"(read offset)",
			"",
			...rows,
			...(notes.length > 0 ? ["", ...notes] : []),
		].join("\n");
	}

	private requireTranscript(): void {
		if (!this.path.endsWith(".jsonl")) {
			throw new Error(`${this.path} is not a pi transcript (.jsonl)`);
		}
		let isFile = false;
		try {
			isFile = statSync(this.path).isFile();
		} catch {
			throw new Error(`transcript ${this.path} no longer exists`);
		}
		if (!isFile) throw new Error(`${this.path} is not a file`);
	}

	private parse(line: string): Json | null {
		try {
			const value = JSON.parse(line);
			return value && typeof value === "object"
				? value as Json : null;
		} catch {
			return null;
		}
	}

	private render(
		entry: Json | null,
		line: string,
		include: ReadonlySet<PeekKind>,
	): Rendered | null {
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

	/** At most `max` chars; a match past the window is kept in view. */
	private clip(full: string, max: number, at: number): string {
		if (full.length <= max) return full;
		const start = at < max * 0.75 ? 0 : at - Math.floor(max / 4);
		const shown = full.slice(start, start + max);
		return (start > 0 ? "… " : "") + shown +
			` … [+${full.length - shown.length} chars]`;
	}
}
