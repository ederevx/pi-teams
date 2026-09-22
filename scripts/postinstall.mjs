#!/usr/bin/env node
/**
 * Fail-soft settings guard: keep at most one packages entry that
 * installs this package. A git pin and a local-path install of the
 * same checkout coexist as two entries, both extensions load, and pi
 * aborts startup with tool-conflict errors. See pi-daemon's
 * scripts/settings-reconciler.mjs for the rule and its rationale.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsReconciler } from "./settings-reconciler.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function version() {
	try {
		return JSON.parse(
			readFileSync(join(repoRoot, "package.json"), "utf8")).version;
	} catch {
		return undefined;
	}
}

try {
	const dropped = new SettingsReconciler(
		SettingsReconciler.defaultPath(), version(), "pi-teams").reconcile();
	if (dropped.length > 0) {
		process.stderr.write(
			"pi-teams: removed duplicate package entries that would load " +
			"its extensions twice: " + dropped.join(", ") + "\n");
	}
} catch (err) {
	process.stderr.write(
		"pi-teams: settings reconciliation skipped (" +
		(err?.message ?? err) + ")\n");
}
process.exit(0);
