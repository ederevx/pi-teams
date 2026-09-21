/**
 * Owns every OS child-process launch for the extension. Each spawn sets
 * windowsHide so no console window flashes on Windows; the option is a
 * documented no-op on Linux and macOS, so the same code behaves
 * identically everywhere.
 */

import { spawn as nodeSpawn } from "node:child_process";

export interface SpawnedProcess {
	stdin: { end(): void; write(data: string): void } | null;
	stdout: { on(event: string, listener: (chunk: unknown) => void): void } | null;
	stderr?: { on(event: string, listener: (chunk: unknown) => void): void } | null;
	on(event: string, listener: (...args: unknown[]) => void): void;
	unref(): void;
	kill(): void;
}

export type SpawnFn = (
	file: string,
	args: string[],
	options?: Record<string, unknown>,
) => SpawnedProcess;

/** The output of a finished child process. */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface RunOptions {
	cwd?: string;
	timeout?: number;
}

/** The seam a TeamAgent uses to launch processes. ProcessRunner is the
 *  only production implementation; tests supply a fake. */
export interface ProcessHost {
	run(
		file: string,
		args: string[],
		options?: RunOptions,
	): Promise<ExecResult>;
	spawnHidden(
		file: string,
		args: string[],
		options?: Record<string, unknown>,
	): SpawnedProcess | null;
	spawnDetached(
		file: string,
		args: string[],
		options?: Record<string, unknown>,
	): SpawnedProcess | null;
	spawnPersistent(
		file: string,
		args: string[],
		options?: Record<string, unknown>,
	): SpawnedProcess | null;
}

/**
 * Owns every OS child-process launch. Each spawn sets windowsHide so no
 * console window flashes on Windows; the option is a documented no-op
 * on Linux and macOS, so the same code behaves identically everywhere.
 */
export class ProcessRunner implements ProcessHost {
	private readonly spawn: SpawnFn;

	constructor(spawn: SpawnFn = nodeSpawn) {
		this.spawn = spawn;
	}

	run(
		file: string,
		args: string[],
		options: RunOptions = {},
	): Promise<ExecResult> {
		return new Promise((resolve) => {
			let child: SpawnedProcess;
			try {
				child = this.spawn(file, args, {
					cwd: options.cwd,
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch {
				resolve({ stdout: "", stderr: "", code: 1 });
				return;
			}
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (code: number): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolve({ stdout, stderr, code });
			};
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("error", () => finish(1));
			child.on("close", (code) => {
				finish(typeof code === "number" ? code : 1);
			});
			if (options.timeout && options.timeout > 0) {
				timer = setTimeout(() => {
					try {
						child.kill();
					} catch {
						// already gone
					}
					finish(1);
				}, options.timeout);
			}
		});
	}

	spawnHidden(
		file: string,
		args: string[],
		options: Record<string, unknown> = {},
	): SpawnedProcess | null {
		try {
			return this.spawn(file, args, { ...options, windowsHide: true });
		} catch {
			return null;
		}
	}

	spawnDetached(
		file: string,
		args: string[],
		options: Record<string, unknown> = {},
	): SpawnedProcess | null {
		// windowsHide is ignored when DETACHED_PROCESS is set, so a
		// detached console child can still flash a window on Windows.
		// A session-scoped child does not need that: keep it hidden and
		// non-detached on Windows, where it is reaped with the parent.
		// On POSIX it detaches so it survives the session.
		return this.spawnHidden(file, args, {
			...options,
			detached: process.platform !== "win32",
		});
	}

	spawnPersistent(
		file: string,
		args: string[],
		options: Record<string, unknown> = {},
	): SpawnedProcess | null {
		// A helper that must outlive the session is always detached (that
		// is what escapes the kill-on-close job on Windows). The caller
		// supplies a windowless launcher there, so no console can flash.
		return this.spawnHidden(file, args, { ...options, detached: true });
	}
}