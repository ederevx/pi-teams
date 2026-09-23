#!/usr/bin/env node
/**
 * Package-install adoption for pi-teams, run by npm after any `pi
 * install`/`pi update` of this package:
 *
 * 1. Fail-soft settings guard: keep at most one packages entry that
 *    installs this package. A git pin and a local-path install of the
 *    same checkout coexist as two entries, both extensions load, and pi
 *    aborts startup with tool-conflict errors. See pi-daemon's
 *    scripts/settings-reconciler.mjs for the rule and its rationale.
 * 2. Manual-copy cleanup: drop the extension and bin copies a prior
 *    manual `scripts/install.sh` left, so the package stays the single
 *    loader source (the extension falls back to the sibling src/
 *    bundled broker/client). See manual-copies.mjs for the rule.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsReconciler } from "./settings-reconciler.mjs";
import { ManualCopyCleaner, piTeamsCandidates, piTeamsPaths } from "./manual-copies.mjs";

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

try {
	const { agentDir, binDir, manifestPath } = piTeamsPaths();
	const removed = new ManualCopyCleaner(
		manifestPath, piTeamsCandidates(agentDir, binDir, repoRoot)).clean();
	if (removed.length > 0) {
		process.stderr.write(
			"pi-teams: removed manual-install copies that would load beside " +
			"the package (single-loader rule): " + removed.join(", ") + "\n");
	}
} catch (err) {
	process.stderr.write(
		"pi-teams: manual-copy cleanup skipped (" +
		(err?.message ?? err) + ")\n");
}
process.exit(0);