/**
 * Peer transport. PeerBridge is the transport-agnostic loopback bridge
 * to a peer host's broker; SshPeerBridge is the SSH implementation. The
 * rest of the extension registers and reaps a peer without knowing SSH
 * exists.
 */

import { createServer } from "node:net";
import { sep } from "node:path";
import { peerSetupScript } from "./paths.ts";
import type { ProcessHost, SpawnedProcess } from "./process-runner.ts";

/** A broker endpoint reachable over a bridge, always on loopback. */
export interface PeerEndpoint {
	host: string;
	port: number;
	token: string;
	name?: string;
}

/**
 * A transport-agnostic loopback bridge to a peer host's broker. The rest
 * of TeamAgent treats every bridge identically: connect yields a
 * reachable endpoint and close reaps it. SSH is one implementation; a
 * direct or test bridge can implement the same interface.
 */
export interface PeerBridge {
	name: string;
	peerHost: string;
	connect(): Promise<PeerEndpoint>;
	close(): void;
	onExit(callback: () => void): void;
}

export type BridgeFactory = (sshTarget: string, label: string) => PeerBridge;

/** Single-quote a value for POSIX sh, escaping embedded quotes. */
function quoteShell(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Builds the one-line, user-run setup command for a password-only host.
 * It owns the script location and the guidance text, so the SSH bridge
 * can report exactly what the user must run without knowing packaging.
 */
export class SshSetupGuide {
	private readonly script: string;

	constructor(script: string = peerSetupScript) {
		this.script = script;
	}

	/** Shell-quotes the script and target so the printed command is safe
	 *  to paste even if either contains spaces or quotes. */
	command(sshTarget: string): string {
		// A pi session's shell is Git Bash on Windows, where Windows
		// backslash paths are not understood; emit forward slashes.
		const script = this.script.split(sep).join("/");
		return `sh ${quoteShell(script)} ${quoteShell(sshTarget)}`;
	}

	/** The error the agent should relay to the user for a failure that a
	 *  one-time interactive setup fixes. */
	needed(sshTarget: string, detail: string): Error {
		const reason = detail.trim() || "ssh could not authenticate";
		return new Error(
			`SSH to ${sshTarget} is not usable non-interactively (${reason}). ` +
			`Do not ask for a password; ask the user to run this one line in ` +
			`their terminal, then retry team_peer:\n  ${this.command(sshTarget)}`);
	}
}

/**
 * The SSH implementation of PeerBridge. It reads the peer broker's
 * loopback endpoint over an existing SSH session, forwards that port to
 * a local loopback port, and owns the ssh process for its whole life.
 * Nothing outside this class knows SSH is involved.
 */
export class SshPeerBridge implements PeerBridge {
	name: string;
	private readonly label: string;
	private readonly sshTarget: string;
	private readonly runner: ProcessHost;
	private readonly remoteState: string;
	private readonly guide: SshSetupGuide;
	private tunnel: SpawnedProcess | null = null;
	private exitCallback: (() => void) | null = null;
	private closed = false;
	peerHost = "";

	constructor(
		sshTarget: string,
		label: string,
		runner: ProcessHost,
		guide: SshSetupGuide = new SshSetupGuide(),
	) {
		this.sshTarget = sshTarget;
		this.label = label;
		this.name = label || sshTarget;
		this.runner = runner;
		this.guide = guide;
		this.remoteState = process.env.PI_TEAMS_REMOTE_STATE
			|| "$HOME/.local/state/pi-teams";
	}

	async connect(): Promise<PeerEndpoint> {
		const endpoint = await this.readEndpoint();
		this.peerHost = endpoint.name || "";
		this.name = this.label || endpoint.name || this.sshTarget;
		const port = await this.reservePort();
		const tunnel = this.runner.spawnDetached("ssh", [
			"-N",
			"-o", "BatchMode=yes",
			"-o", "ExitOnForwardFailure=yes",
			"-o", "ServerAliveInterval=5",
			"-o", "ServerAliveCountMax=2",
			"-L",
			`127.0.0.1:${port}:127.0.0.1:${endpoint.port}`,
			this.sshTarget,
		], { stdio: "ignore" });
		if (!tunnel) {
			throw new Error(
				`ssh tunnel to ${this.sshTarget} failed to start`);
		}
		this.tunnel = tunnel;
		tunnel.on("exit", () => {
			this.tunnel = null;
			this.closed = true;
			this.exitCallback?.();
		});
		tunnel.on("error", () => {
			// A tunnel that never started (no ssh binary, spawn failure)
			// reports through "error", not a thrown exception; left
			// unhandled it would crash the host session. Treat it as an
			// exit so onExit subscribers still reap the peer.
			if (this.tunnel === tunnel) this.tunnel = null;
			if (!this.closed) {
				this.closed = true;
				this.exitCallback?.();
			}
		});
		tunnel.unref();
		return {
			host: "127.0.0.1", port, token: endpoint.token,
			name: this.name,
		};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.exitCallback = null;
		const tunnel = this.tunnel;
		this.tunnel = null;
		try {
			tunnel?.kill();
		} catch {
			// already gone
		}
	}

	onExit(callback: () => void): void {
		// The tunnel may already have exited between connect() and this
		// registration; report it at once instead of never firing.
		if (this.closed) {
			callback();
			return;
		}
		this.exitCallback = callback;
	}

	private async readEndpoint(): Promise<{
		port: number;
		token: string;
		name?: string;
	}> {
		// BatchMode fails fast instead of prompting for a password or a
		// host key; with no TTY a prompt would otherwise hang the call.
		const result = await this.runner.run("ssh", [
			"-o", "BatchMode=yes",
			"-o", "ConnectTimeout=10",
			"-o", "ConnectionAttempts=1",
			this.sshTarget, "cat", `${this.remoteState}/endpoint`,
		], { timeout: 15000 });
		if (result.code !== 0) {
			throw this.guide.needed(
				this.sshTarget, this.classify(result.stderr));
		}
		try {
			return JSON.parse(result.stdout.trim()) as {
				port: number;
				token: string;
				name?: string;
			};
		} catch {
			throw this.guide.needed(this.sshTarget,
				"the endpoint file could not be read");
		}
	}

	/** Turns an ssh failure's stderr into a short human reason. */
	private classify(stderr: string): string {
		if (/host key verification failed/i.test(stderr)) {
			return "the host key is not known or has changed";
		}
		if (/permission denied \(/i.test(stderr)) {
			return "the host needs a password or a different key";
		}
		const line = stderr.split("\n").find((l) => l.trim() !== "");
		return line ? line.trim() : "";
	}

	/** A loopback port reserved and released at once: ssh binds it when
	 *  the tunnel starts. The listener never outlives this call. */
	private reservePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer();
			server.on("error", (err) => {
				try {
					server.close();
				} catch {
					// never listened
				}
				reject(err);
			});
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				const port = typeof address === "object" && address
					? address.port
					: 0;
				server.close(() => resolve(port));
			});
		});
	}
}