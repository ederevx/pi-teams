/**
 * Resolves a Python interpreter to use for the broker and client,
 * including the GUI-subsystem twin on Windows. Interpreter selection is
 * the only responsibility this module owns.
 */

import { spawnSync } from "node:child_process";

/** Resolves a Python interpreter without a platform branch: an explicit
 *  PYTHON wins, otherwise the first of python3/python/py that answers
 *  (py is the launcher on Windows). */
export function resolvePython(): string {
	if (process.env.PYTHON) return process.env.PYTHON;
	for (const candidate of ["python3", "python", "py"]) {
		try {
			if (spawnSync(candidate, ["--version"], {
				stdio: "ignore", windowsHide: true,
			}).status === 0) {
				return candidate;
			}
		} catch {
			// try the next candidate
		}
	}
	return "python3";
}

/** Runs a trivial program to test that an interpreter candidate works. */
type InterpreterProbe = (candidate: string) => boolean;

function defaultProbe(candidate: string): boolean {
	try {
		return spawnSync(candidate, ["-c", "pass"], {
			stdio: "ignore", windowsHide: true,
		}).status === 0;
	} catch {
		return false;
	}
}

/** The GUI-subsystem name candidates for a Python interpreter. */
export function windowlessCandidates(interpreter: string): string[] {
	const lower = interpreter.toLowerCase();
	const candidates: string[] = [];
	if (lower.endsWith("python.exe")) {
		candidates.push(
			interpreter.slice(0, -"python.exe".length) + "pythonw.exe");
	} else if (lower.endsWith("python3.exe")) {
		candidates.push(
			interpreter.slice(0, -"python3.exe".length) + "pythonw3.exe");
	}
	if (lower === "python" || lower === "python.exe") {
		candidates.push("pythonw");
	}
	if (lower === "python3" || lower === "python3.exe") {
		candidates.push("pythonw3");
	}
	if (lower === "py" || lower === "py.exe") {
		candidates.push("pyw");
	}
	candidates.push("pythonw");
	return candidates;
}

/** Maps an interpreter to the one a launch should actually use. */
export interface InterpreterResolver {
	resolve(): string;
}

/**
 * Maps a Python interpreter to its GUI-subsystem twin on Windows, so a
 * detached broker has no console to flash. Off Windows, and when no twin
 * exists, the interpreter is returned unchanged.
 */
export class WindowlessPython implements InterpreterResolver {
	private readonly interpreter: string;
	private readonly probe: InterpreterProbe;

	constructor(
		interpreter: string,
		probe: InterpreterProbe = defaultProbe,
	) {
		this.interpreter = interpreter;
		this.probe = probe;
	}

	resolve(): string {
		if (process.platform !== "win32") return this.interpreter;
		for (const candidate of windowlessCandidates(this.interpreter)) {
			if (candidate !== this.interpreter && this.probe(candidate)) {
				return candidate;
			}
		}
		return this.interpreter;
	}
}