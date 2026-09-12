/**
 * Redis TTL for one school's cached flag verdict.
 *
 * This IS the propagation guarantee, not a backstop: a per-tenant override flipped in
 * `app.feature_flags` is served stale for at most this long, and the flip's acceptance criterion
 * bounds propagation at 30 seconds ("<30s without deploy"). 10 seconds trades a little latency on
 * one Redis GET per (flag, school) evaluation for a flip that lands well inside the bound on the
 * next read. Lowering it costs one more cache miss per school per flag per interval; raising it
 * past 30 would break the criterion.
 */
export const FLAGS_CACHE_TTL_SECONDS = 10;
