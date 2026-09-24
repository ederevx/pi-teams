/**
 * pi-teams - settings view.
 *
 * One responsibility: render TeamSettingsPresenter rows through pi's own
 * two-column SettingsList (padded label | current value, selected row's
 * description and key hint below) framed by DynamicBorder, and forward
 * keyboard input to the list. Pure presentation: persistence and
 * validation belong to the presenter, and accepted changes are reported
 * to the caller's callback.
 */

import {
	Container,
	SettingsList,
	type SettingItem,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { SettingRow, ViewTheme } from "./settings-presenter.ts";

export class TeamSettingsView extends Container {
	private readonly list: SettingsList;

	constructor(
		rows: readonly SettingRow[],
		theme: ViewTheme,
		onChange: (id: string, value: string) => void,
		onCancel: () => void,
	) {
		super();
		const border = (text: string): string => theme.fg("border", text);
		this.list = new SettingsList(
			rows.map((row) => TeamSettingsView.toItem(row)),
			rows.length, // every row stays reachable; the list scrolls.
			TeamSettingsView.themeFor(theme),
			onChange,
			onCancel,
		);
		this.addChild(new DynamicBorder(border));
		this.addChild(this.list);
		this.addChild(new DynamicBorder(border));
	}

	/** Forward focus input to the list; the Container base has none. */
	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	/** Move the selection to a row id (programmatic navigation). */
	selectItem(id: string): void {
		this.list.selectItem(id);
	}

	/** One SettingItem: an editable input submenu, or a value row the
	 *  list cycles in place. */
	private static toItem(row: SettingRow): SettingItem {
		const item: SettingItem = {
			id: row.id,
			label: row.title,
			description: row.description,
			currentValue: row.value,
		};
		if (row.values) item.values = [...row.values];
		if (row.submenu) item.submenu = row.submenu;
		return item;
	}

	/** pi's settings palette, built from the injected theme (jiti-safe). */
	private static themeFor(theme: ViewTheme): SettingsListTheme {
		return {
			label: (text, selected) => (selected ? theme.fg("accent", text) : text),
			value: (text, selected) =>
				selected ? theme.fg("accent", text) : theme.fg("muted", text),
			description: (text) => theme.fg("dim", text),
			cursor: theme.fg("accent", "→ "),
			hint: (text) => theme.fg("dim", text),
		};
	}
}
