/**
 * Auto context policy for teammate spawns. One responsibility: decide
 * whether an auto-context spawn forks the parent session ("inherit") or
 * starts clean ("fresh"), because a fork is only a cache win while the
 * parent's provider cache entry is still alive. Explicit "fresh" and
 * "inherit" requests never reach this policy.
 *
 * Decision: inherit only when the parent session file exists, was last
 * written within 0.8x of the provider cache TTL (so the provider's
 * prefix entry is plausibly still warm), and the session stays modest
 * enough that the per-turn 0.1x cache-read drag of the inherited
 * history cannot outweigh the ~1.15x head-write it saves. Provider
 * TTLs mirror pi-cache's `provider-ttl.ts` static profiles.
 */

import { statSync } from "node:fs";

/** One static provider profile: match tokens against the provider id. */
interface ProviderTtlProfile {
	/** Case-insensitive substrings matched against the provider id. */
	matches: readonly string[];
	seconds: number;
}

export class ContextPolicy {
	/** Fraction of the provider TTL within which the entry is assumed
	 *  alive: hits refresh the TTL, so just-written caches are warm. */
	private static readonly TTL_FRACTION = 0.8;
	/** Global fallback when no profile matches (pi-cache default 300 s). */
	private static readonly DEFAULT_TTL_SECONDS = 300;
	/** Byte cap on the parent session file: past roughly this size the
	 *  inherited history is dead weight every turn, so fresh wins even
	 *  with a warm cache. ~512 KB of transcript is well past the
	 *  break-even for typical system+tools heads. */
	private static readonly MAX_SESSION_BYTES = 512 * 1024;

	/** Ordered profiles; the first matching substring wins. GLM sorts
	 *  first because its measured 120 s TTL is the shortest common one. */
	private static readonly PROFILES: readonly ProviderTtlProfile[] = [
		{ matches: ["z-ai", "glm"], seconds: 120 },
		{ matches: ["openai"], seconds: 1800 },
		{ matches: ["deepseek"], seconds: 14400 },
	];

	/** Whether an auto-context spawn forks the parent session. Returns
	 *  "fresh" whenever the file is unreadable (no session to fork, or
	 *  an entry the parent's cache no longer covers). */
	autoContext(sessionFile: string, provider?: string): "fresh" | "inherit" {
		try {
			const stat = statSync(sessionFile);
			if (stat.size > ContextPolicy.MAX_SESSION_BYTES) return "fresh";
			const aliveMs =
				this.ttlSeconds(provider) * 1000 * ContextPolicy.TTL_FRACTION;
			return Date.now() - stat.mtimeMs < aliveMs ? "inherit" : "fresh";
		} catch {
			return "fresh";
		}
	}

	/** The provider's static cache TTL; profiles match on provider id
	 *  substrings so `z-ai/glm-5.3-flash` style ids hit without an
	 *  exact table. */
	private ttlSeconds(provider?: string): number {
		const id = (provider ?? "").toLowerCase();
		for (const profile of ContextPolicy.PROFILES) {
			if (profile.matches.some((m) => id.includes(m))) {
				return profile.seconds;
			}
		}
		return ContextPolicy.DEFAULT_TTL_SECONDS;
	}
}
