/**
 * Incremental reader for one pi transcript (.jsonl): the complete lines
 * added since the last read, from a bounded window. It owns the byte
 * cursor the live team_wait stream follows; a paged reader keeps its own.
 * Only whole lines are consumed, so a line (or a multi-byte character)
 * still being written is picked up by the next read.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

export class TranscriptTail {
	/** How far a first read (or a reopen) starts from the end. */
	private static readonly BACKFILL_BYTES = 16 * 1024;
	/** The most one read returns; further behind, the window skips
	 *  forward instead of replaying a long log. */
	private static readonly MAX_READ_BYTES = 64 * 1024;

	private readonly path: string;
	private offset = 0;
	private ino = -1;
	private opened = false;
	private partial = false;
	private absent = false;

	constructor(path: string) {
		this.path = path;
	}

	/** Whether the last read found no transcript file. pi writes the
	 *  file on the session's first flush, so an early wait sees none. */
	get missing(): boolean {
		return this.absent;
	}

	read(): string[] {
		const stat = this.stat();
		if (!stat) {
			this.absent = true;
			return [];
		}
		this.absent = false;
		if (!this.opened || stat.ino !== this.ino || stat.size < this.offset) {
			// First read, or the file was replaced (a resumed session
			// rewrites it): start inside the tail, not at the beginning.
			this.opened = true;
			this.ino = stat.ino;
			this.offset = Math.max(0, stat.size - TranscriptTail.BACKFILL_BYTES);
			// A window that starts mid-file starts mid-line.
			this.partial = this.offset > 0;
		}
		const available = stat.size - this.offset;
		if (available <= 0) return [];
		const length = Math.min(available, TranscriptTail.MAX_READ_BYTES);
		const buffer = this.readFrom(length);
		if (!buffer) return [];
		const end = buffer.lastIndexOf(0x0a);
		if (end < 0) {
			// No complete line in the window: a line longer than the cap
			// can never complete, so skip it instead of stalling.
			if (length === TranscriptTail.MAX_READ_BYTES) {
				this.offset += length;
			}
			return [];
		}
		const lines = buffer.subarray(0, end).toString("utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
		this.offset += end + 1;
		if (this.partial && lines.length > 0) lines.shift();
		this.partial = false;
		return lines;
	}

	private stat(): { size: number; ino: number } | null {
		try {
			const stat = statSync(this.path);
			return stat.isFile()
				? { size: stat.size, ino: stat.ino } : null;
		} catch {
			return null;
		}
	}

	private readFrom(length: number): Buffer | null {
		const buffer = Buffer.allocUnsafe(length);
		let fd = -1;
		try {
			fd = openSync(this.path, "r");
			readSync(fd, buffer, 0, length, this.offset);
			return buffer;
		} catch {
			this.absent = true;
			return null;
		} finally {
			if (fd >= 0) {
				try {
					closeSync(fd);
				} catch {
					// already closed
				}
			}
		}
	}
}
