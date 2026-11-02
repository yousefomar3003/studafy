/**
 * In-process token bucket for SES send pacing.
 *
 * SES throttles send volume per account per region, and the dispatcher process is the only mailer
 * in an environment, so a per-process limiter is sufficient — no shared counter is needed. The
 * bucket starts full, so a burst up to `ratePerSecond` is allowed immediately, then one token is
 * replenished per second on average.
 */

export interface RateLimiter {
  /** Block until a send token is available. Resolves immediately when the bucket has one. */
  wait(): Promise<void>;
}

/** Returns the current wall-clock time in ms. Injectable so tests can run on fake time. */
export type Now = () => number;

export class TokenBucket implements RateLimiter {
  private readonly tokensPerMs: number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    ratePerSecond: number,
    private readonly now: Now = () => Date.now(),
  ) {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
      throw new Error("ratePerSecond must be a positive finite number");
    }
    this.tokensPerMs = ratePerSecond / 1000;
    this.tokens = ratePerSecond;
    this.lastRefillMs = now();
  }

  async wait(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.refill(now);

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      // Sleep for exactly the time the next token needs to accumulate, then re-check. Re-arming
      // from the sleep inside the loop keeps drift from accumulating across many waits.
      const neededMs = Math.ceil((1 - this.tokens) / this.tokensPerMs);
      await sleep(neededMs);
    }
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillMs;
    if (elapsed <= 0) return;
    // The bucket never exceeds the burst capacity; a process that idles for an hour does not
    // accumulate a one-hour burst.
    this.tokens = Math.min(this.tokens + elapsed * this.tokensPerMs, this.tokensPerMs * 1000);
    this.lastRefillMs = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
