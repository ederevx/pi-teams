/**
 * Tail the pi chat history: locate the newest session transcript
 * (.jsonl) under the pi agent sessions directory and return its last
 * lines verbatim. One responsibility - showing the agent its own
 * conversation - owned by the ChatTail class.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface Transcript {
	path: string;
	mtime: number;
}

export class ChatTail {
	private readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	/** All .jsonl transcripts under root, oldest first. */
	private collect(): Transcript[] {
		const found: Transcript[] = [];
		this.walk(this.root, found);
		found.sort((a, b) => a.mtime - b.mtime);
		return found;
	}

	private walk(dir: string, out: Transcript[]): void {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			try {
				if (entry.isDirectory()) {
					this.walk(path, out);
				} else if (entry.name.endsWith(".jsonl")) {
					out.push({ path, mtime: statSync(path).mtime });
				}
			} catch {
				// unreadable entry: skip it and continue scanning
			}
		}
	}

	/** Absolute path of the most recently modified transcript, or null. */
	newestPath(): string | null {
		const found = this.collect();
		return found.length > 0
			? found[found.length - 1].path
			: null;
	}

	/** Up to `lines` trailing lines of the newest transcript. */
	tail(lines: number): string {
		const path = this.newestPath();
		if (path === null) return "pi-teams: no chat history found";
		let text: string;
		try {
			text = readFileSync(path, "utf-8");
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return `pi-teams: could not read ${path}: ${detail}`;
		}
		const all = text.split("\n");
		if (all.length > 0 && all[all.length - 1].length === 0) {
			all.pop();
		}
		const start = Math.max(0, all.length - lines);
		return `pi-teams: tailing ${path}\n` + all.slice(start).join("\n");
	}
}