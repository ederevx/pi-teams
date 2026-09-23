/**
 * The teammates dock: a settings-style overlay listing every live
 * pi-teams agent. It uses the same SettingsList component and theme the
 * settings screen uses, so the layout matches, and each row shows how
 * long since the agent was last seen active. The dock is read-only by
 * design: it shows the team, while acting on a teammate stays a tool
 * call (team_send, team_attach, team_kill).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentInfo } from "./directory.ts";

/** Opens the teammates dock: one settings-style row per live agent,
 *  showing its role and how long since it was last seen active;
 *  Escape closes it. In a non-TUI session (no dock can render) the
 *  same listing is shown as a plain notification. */
export async function openTeammatesDock(
	agents: AgentInfo[],
	ctx: ExtensionContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		notifyList(agents, ctx);
		return;
	}
	// The host provides these at runtime; the imports stay dynamic so a
	// test or embedder without the TUI package never needs them.
	const [{ Container, SettingsList }, { getSettingsListTheme }] =
		await Promise.all([
			import("@earendil-works/pi-tui"),
			import("@earendil-works/pi-coding-agent"),
		]);
	const now = Date.now() / 1000;
	const items = agents.map((agent) => ({
		id: agent.id,
		label: agent.name && agent.name !== agent.id
			? `${agent.name} — ${agent.id}`
			: agent.id,
		description: describeAgent(agent),
		currentValue: presenceText(agent, now),
	}));
	await ctx.ui.custom((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new (class {
			render(): string[] {
				return [
					theme.fg("accent", theme.bold("pi-teams teammates")),
					theme.fg("muted",
						`${agents.length} agent(s)`),
					"",
				];
			}
			invalidate(): void {}
		})());
		const list = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			// Read-only rows: no values to cycle, so onChange cannot
			// fire; Escape closes through onCancel.
			() => {},
			() => done(undefined),
		);
		container.addChild(list);
		return {
			render(width: number): string[] {
				return container.render(width);
			},
			invalidate(): void {
				container.invalidate();
			},
			handleInput(data: string): void {
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

/** Describes an agent for its dock row: role, host, parent, session. */
function describeAgent(agent: AgentInfo): string {
	const parts = [agent.role];
	if (agent.remote) parts.push(`peer ${agent.origin ?? "remote"}`);
	if (agent.parent) parts.push(`child of ${agent.parent}`);
	if (agent.session) {
		const slash = agent.session.lastIndexOf("/");
		parts.push(`session ${agent.session.slice(slash + 1)}`);
	}
	return parts.join(" · ");
}

/** A row's right-side value: online state plus how long since the
 *  agent was last seen active. `last_work` is the honest measure (the
 *  last busy/work contact); `last_seen` answers when no work was ever
 *  published. Both are broker-clock epoch seconds from the same
 *  snapshot, so the comparison is clock-consistent. */
function presenceText(agent: AgentInfo, now: number): string {
	const state = agent.online ? "online" : "offline";
	return `${state}, active ${lastActiveText(agent, now)}`;
}

/** How long since the agent was last active, or "never" when the
 *  broker never published a contact for it. Callers pass the same
 *  snapshot clock the stamps come from. */
function lastActiveText(agent: AgentInfo, now: number): string {
	const stamp = agent.last_work ?? agent.last_seen;
	return stamp === undefined ? "never" : `${relative(now - stamp)} ago`;
}

/** Human text for a duration in seconds: 42s, 7m, 3h, 2d. */
function relative(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** The non-TUI fallback: the same listing as plain text. */
function notifyList(agents: AgentInfo[], ctx: ExtensionContext): void {
	const now = Date.now() / 1000;
	const lines = agents.map((agent) =>
		`${agent.id}\t${agent.role}\t` +
		`${agent.online ? "online" : "offline"}` +
		(agent.parent ? `\tchild of ${agent.parent}` : "") +
		`\tlast active ${lastActiveText(agent, now)}`);
	ctx.ui.notify(
		`pi-teams: ${agents.length} agent(s)\n` +
		(lines.join("\n") || "(none)"),
		"info");
}
