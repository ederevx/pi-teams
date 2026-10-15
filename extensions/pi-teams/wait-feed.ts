/**
 * The live team_wait view's model: one bounded section of recent
 * activity per waited teammate, plus the elapsed header. The wait's own
 * tick drives it, so it owns no timer and can never outlive the wait.
 */

export interface TeamWaitStreamSection {
	id: string;
	state: string;
	lines: string[];
}

export interface TeamWaitSnapshot {
	text: string;
	streams: TeamWaitStreamSection[];
}

interface Section {
	state: string;
	lines: string[];
}

export class TeamWaitFeed {
	private static readonly MAX_BYTES = 16 * 1024;
	private static readonly MAX_LINE_CHARS = 300;
	private static readonly MAX_EVENTS = 40;
	private static readonly MAX_SECTIONS = 8;

	private readonly order: readonly string[];
	private readonly sections = new Map<string, Section>();
	private readonly deliver: (snapshot: TeamWaitSnapshot) => void;
	private readonly started: number;
	private lastText = "";
	private closed = false;

	constructor(
		ids: readonly string[],
		deliver: (snapshot: TeamWaitSnapshot) => void,
		started = Date.now(),
	) {
		this.order = ids;
		this.deliver = deliver;
		this.started = started;
		for (const id of ids) this.sections.set(id, { state: "starting", lines: [] });
	}

	/** Appends one activity line to a stream. */
	note(id: string, line: string): void {
		const section = this.sections.get(id);
		if (!section || this.closed) return;
		const clean = line.replace(/\s+/g, " ").trim();
		if (!clean) return;
		section.lines.push(this.clip(clean));
		while (section.lines.length > TeamWaitFeed.MAX_EVENTS) section.lines.shift();
		this.trim();
	}

	/** Replaces one stream's state label (live, quiet, peer, error). */
	mark(id: string, state: string): void {
		const section = this.sections.get(id);
		if (!section || this.closed) return;
		section.state = state;
	}

	/** Delivers the snapshot when it changed; the elapsed header
	 *  changes it once a second, so a quiet wait still reports. */
	publish(now = Date.now()): void {
		if (this.closed) return;
		const snapshot = this.snapshot(now);
		if (snapshot.text === this.lastText) return;
		this.lastText = snapshot.text;
		try {
			this.deliver(snapshot);
		} catch {
			// The host's update callback must never break the wait.
		}
	}

	snapshot(now = Date.now()): TeamWaitSnapshot {
		const streams = this.order.map((id) => {
			const section = this.sections.get(id);
			return {
				id,
				state: section?.state ?? "starting",
				lines: [...(section?.lines ?? [])],
			};
		});
		const elapsed = Math.round((now - this.started) / 1000);
		const shown = streams.slice(0, TeamWaitFeed.MAX_SECTIONS);
		const parts = [
			`waiting for ${streams.length} teammate(s) (${elapsed}s elapsed)`,
		];
		for (const stream of shown) {
			parts.push(`── ${stream.id} (${stream.state}) ──`);
			if (stream.lines.length === 0) parts.push("(no activity yet)");
			for (const line of stream.lines) parts.push(line);
		}
		if (streams.length > shown.length) {
			parts.push(`+${streams.length - shown.length} more: ` +
				streams.slice(TeamWaitFeed.MAX_SECTIONS)
					.map((stream) => `${stream.id} (${stream.state})`)
					.join(", "));
		}
		return { text: parts.join("\n"), streams };
	}

	/** Stops delivering; later calls are no-ops. */
	close(): void {
		this.closed = true;
	}

	private trim(): void {
		while (this.bytes() > TeamWaitFeed.MAX_BYTES) {
			const longest = this.longest();
			// Never empty a section: a chatty teammate must not push a
			// quiet one out of view.
			if (longest < 2) return;
			const section = this.longestSection();
			if (!section) return;
			section.lines.shift();
		}
	}

	private bytes(): number {
		let total = 0;
		for (const section of this.sections.values()) {
			for (const line of section.lines) total += Buffer.byteLength(line, "utf8") + 1;
		}
		return total;
	}

	private longest(): number {
		let longest = 0;
		for (const section of this.sections.values()) {
			longest = Math.max(longest, section.lines.length);
		}
		return longest;
	}

	private longestSection(): Section | undefined {
		let found: Section | undefined;
		for (const section of this.sections.values()) {
			if (!found || section.lines.length > found.lines.length) found = section;
		}
		return found;
	}

	private clip(text: string): string {
		if (text.length <= TeamWaitFeed.MAX_LINE_CHARS) return text;
		return `${text.slice(0, TeamWaitFeed.MAX_LINE_CHARS)}…`;
	}
}
