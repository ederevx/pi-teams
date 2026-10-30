/**
 * The live stream behind team_wait: resolves each waited teammate's pi
 * transcript, follows it incrementally on the wait's own tick, and feeds
 * the tool view. A teammate on another host has no readable transcript
 * here, so its stream reports that instead.
 */

import { ChatEntryRenderer, type PeekKind } from "./chat-entry.ts";
import { TranscriptTail } from "./transcript-tail.ts";
import { TeamWaitFeed } from "./wait-feed.ts";

/** One teammate's local transcript, or why it has none. */
export interface TranscriptRef {
	id: string;
	path?: string;
	error?: string;
	peer?: boolean;
}

/** Resolves teammate ids to transcripts readable on this host. */
export interface TranscriptSource {
	transcriptsOf(ids: readonly string[]): Promise<TranscriptRef[]>;
}

export class TeamWaitStream {
	/** How often an unresolved id is looked up again (about 2s). */
	private static readonly RESOLVE_EVERY_TICKS = 8;
	/** Silence after which a stream reads as quiet rather than live. */
	private static readonly QUIET_AFTER_MS = 10_000;
	/** Reasoning is left out: it doubles the noise for no signal. */
	private static readonly INCLUDE: ReadonlySet<PeekKind> = new Set([
		"user", "assistant", "tool", "custom", "summary",
	]);

	private readonly ids: readonly string[];
	private readonly source: TranscriptSource;
	private readonly feed: TeamWaitFeed;
	private readonly renderer = new ChatEntryRenderer();
	private readonly tails = new Map<string, TranscriptTail>();
	private readonly lastEvent = new Map<string, number>();
	private ticks = 0;
	private resolving = false;
	private closed = false;

	constructor(
		ids: readonly string[],
		source: TranscriptSource,
		feed: TeamWaitFeed,
	) {
		this.ids = ids;
		this.source = source;
		this.feed = feed;
	}

	/** Resolves the transcripts without blocking the wait. */
	start(): void {
		void this.resolve();
	}

	/** Reads every resolved transcript; the wait calls this per tick. */
	tick(now = performance.now()): void {
		if (this.closed) return;
		this.ticks += 1;
		if (this.ticks % TeamWaitStream.RESOLVE_EVERY_TICKS === 0) {
			void this.resolve();
		}
		for (const [id, tail] of this.tails) {
			const lines = tail.read();
			if (tail.missing) {
				this.feed.mark(id, "starting (no transcript yet)");
				continue;
			}
			for (const line of lines) {
				const entry = this.renderer.render(
					this.renderer.parse(line), line, TeamWaitStream.INCLUDE);
				if (!entry) continue;
				this.feed.note(id, `[${entry.label}] ${entry.full}`);
				this.lastEvent.set(id, now);
			}
			this.feed.mark(id, this.stateOf(id, now));
		}
		this.feed.publish(now);
	}

	/** Stops the stream; the final tool result replaces its view. */
	close(): void {
		this.closed = true;
		this.feed.close();
	}

	private stateOf(id: string, now: number): string {
		const at = this.lastEvent.get(id);
		if (at === undefined) return "live (no output yet)";
		const age = Math.floor((now - at) / 1000);
		return age * 1000 >= TeamWaitStream.QUIET_AFTER_MS
			? `quiet ${age}s` : "live";
	}

	private async resolve(): Promise<void> {
		if (this.closed || this.resolving) return;
		this.resolving = true;
		try {
			const refs = await this.source.transcriptsOf(this.ids);
			if (this.closed) return;
			for (const ref of refs) {
				if (this.tails.has(ref.id)) continue;
				if (ref.path) {
					this.tails.set(ref.id, new TranscriptTail(ref.path));
					this.feed.mark(ref.id, "starting");
				} else if (ref.peer) {
					this.feed.mark(ref.id, "peer: no live view");
				} else {
					this.feed.mark(ref.id, `starting (${ref.error ?? "no transcript yet"})`);
				}
			}
		} catch {
			// Unresolved ids keep the feed's own starting state.
		} finally {
			this.resolving = false;
		}
	}
}
