/**
 * Jittered exponential backoff for socket reconnects. Pure and side-effect free so it can be unit
 * tested in isolation and injected with a deterministic `random`.
 */

export interface BackoffOptions {
  /** First non-jittered delay, e.g. 1_000 ms. */
  readonly baseDelayMs: number;
  /** Ceiling on the raw (pre-jitter) delay. */
  readonly maxDelayMs: number;
  /** Upper bound on the uniform jitter fraction applied to each raw delay. */
  readonly jitterRatio: number;
  /** Random source, injectable for deterministic tests. */
  readonly random: () => number;
}

/**
 * Returns the delay before reconnect attempt `attempt` (0-based). The raw delay grows
 * exponentially (`baseDelayMs * 2^attempt`, capped at `maxDelayMs`) and is then jittered by up to
 * `±jitterRatio`, so retries spread out instead of stampeding while still backing off overall.
 */
export function computeBackoffDelay(attempt: number, options: BackoffOptions): number {
  const { baseDelayMs, maxDelayMs, jitterRatio, random } = options;
  const raw = Math.min(baseDelayMs * 2 ** Math.max(0, attempt), maxDelayMs);
  const jitter = (random() * 2 - 1) * jitterRatio;
  return Math.max(0, Math.round(raw * (1 + jitter)));
}
