/**
 * Circuit breaker for the ERPNext plane (ST-119).
 *
 * A retry policy protects a caller from a blip. It makes a sustained outage worse: every request
 * pays the full timeout budget three times over before failing, and the pile-up of in-flight
 * requests is itself load on a system that is already unwell. The breaker is the other half —
 * after enough consecutive failures it fails fast, gives the upstream a quiet window, then lets a
 * single request through to find out whether the outage is over.
 *
 * Two implementations, chosen by whether Redis is configured:
 *
 *   - {@link RedisCircuitBreaker} — breaker state shared across every API task, so the fifth
 *     failure anywhere opens the circuit everywhere. This is the one that matters in production,
 *     where the app runs several ECS tasks and each would otherwise need its own five failures.
 *   - {@link InMemoryCircuitBreaker} — per-process. Used when Redis is absent, which is the local
 *     and test configuration; `app.ts` already guards every Redis use with `if (redis)`.
 *
 * State is keyed per school, because one tenant's ERPNext site being down says nothing about
 * another's — they are separate Frappe sites behind the same host.
 */

import type { Logger } from "../logger";
import type { RedisClient } from "../redis";

export type CircuitState = "closed" | "open" | "half_open";

export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_COOLDOWN_MS = 30_000;

/** Raised instead of calling through when the circuit is open. */
export class CircuitOpenError extends Error {
  readonly key: string;

  constructor(key: string) {
    super("Circuit is open for this ERPNext site");
    this.name = "CircuitOpenError";
    this.key = key;
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long the circuit stays open before admitting a probe. */
  cooldownMs?: number;
  /**
   * Which errors count toward opening. Defaults to counting everything, but the ERPNext client
   * passes a predicate that excludes 4xx: a validation rejection means ERPNext is *working*, and
   * counting it would let a user typing bad input open the circuit for their whole school.
   */
  isFailure?: (error: unknown) => boolean;
}

export interface CircuitBreaker {
  execute<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Exposed for tests and for the health endpoint; not used on the request path. */
  state(key: string): Promise<CircuitState>;
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

interface MemoryEntry {
  failures: number;
  openedAt: number | null;
  probeInFlight: boolean;
}

export class InMemoryCircuitBreaker implements CircuitBreaker {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly isFailure: (error: unknown) => boolean;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.isFailure = options.isFailure ?? (() => true);
  }

  private entry(key: string): MemoryEntry {
    let found = this.entries.get(key);
    if (!found) {
      found = { failures: 0, openedAt: null, probeInFlight: false };
      this.entries.set(key, found);
    }
    return found;
  }

  async state(key: string): Promise<CircuitState> {
    const entry = this.entry(key);
    if (entry.openedAt === null) return "closed";
    return Date.now() - entry.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  async execute<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const entry = this.entry(key);

    if (entry.openedAt !== null) {
      const elapsed = Date.now() - entry.openedAt;
      if (elapsed < this.cooldownMs) throw new CircuitOpenError(key);
      // Cooldown elapsed: exactly one caller becomes the probe, the rest keep failing fast so a
      // recovering upstream is not immediately buried by the backlog that accumulated while open.
      if (entry.probeInFlight) throw new CircuitOpenError(key);
      entry.probeInFlight = true;
    }

    try {
      const result = await fn();
      entry.failures = 0;
      entry.openedAt = null;
      entry.probeInFlight = false;
      return result;
    } catch (error) {
      entry.probeInFlight = false;
      if (this.isFailure(error)) {
        entry.failures += 1;
        if (entry.failures >= this.threshold) entry.openedAt = Date.now();
      } else {
        // A verdict from a healthy upstream. It neither opens the circuit nor counts as recovery.
        entry.failures = 0;
        entry.openedAt = null;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * One script, three modes, so a single SHA is cached — the convention rateLimiter.ts established.
 *
 * KEYS: failures, openedAt, probe.  ARGV: mode, now(ms), threshold, cooldownMs.
 */
const BREAKER_SCRIPT = `
local fKey = KEYS[1]
local oKey = KEYS[2]
local pKey = KEYS[3]
local mode = ARGV[1]
local now = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])
local cooldown = tonumber(ARGV[4])
local ttl = math.ceil((cooldown * 4) / 1000)

if mode == 'acquire' then
  local openedAt = tonumber(redis.call('GET', oKey))
  if openedAt == nil then
    return {1, 'closed'}
  end
  if (now - openedAt) < cooldown then
    return {0, 'open'}
  end
  if redis.call('SET', pKey, '1', 'NX', 'PX', cooldown) then
    return {1, 'half_open'}
  end
  return {0, 'open'}
end

if mode == 'success' then
  redis.call('DEL', fKey, oKey, pKey)
  return {1, 'closed'}
end

if mode == 'failure' then
  local failures = redis.call('INCR', fKey)
  redis.call('EXPIRE', fKey, ttl)
  redis.call('DEL', pKey)
  if failures >= threshold then
    redis.call('SET', oKey, now, 'PX', cooldown * 4)
    return {failures, 'open'}
  end
  return {failures, 'closed'}
end

if mode == 'peek' then
  local openedAt = tonumber(redis.call('GET', oKey))
  if openedAt == nil then
    return {0, 'closed'}
  end
  if (now - openedAt) < cooldown then
    return {0, 'open'}
  end
  return {0, 'half_open'}
end

return redis.error_reply('unknown mode')
`;

let scriptSha: string | null = null;

/** Test seam: the SHA is module-level cache, and a fresh Redis in a test has no scripts loaded. */
export function resetCircuitBreakerScript(): void {
  scriptSha = null;
}

async function ensureScript(redis: RedisClient): Promise<string> {
  if (scriptSha) return scriptSha;
  scriptSha = (await redis.script("LOAD", BREAKER_SCRIPT)) as string;
  return scriptSha;
}

export class RedisCircuitBreaker implements CircuitBreaker {
  private readonly redis: RedisClient;
  private readonly logger: Logger;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly isFailure: (error: unknown) => boolean;
  /** Used when Redis itself is unreachable, so the breaker degrades rather than disappearing. */
  private readonly fallback: InMemoryCircuitBreaker;

  constructor(redis: RedisClient, logger: Logger, options: CircuitBreakerOptions = {}) {
    this.redis = redis;
    this.logger = logger.child({ component: "erpnext-circuit-breaker" });
    this.threshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.isFailure = options.isFailure ?? (() => true);
    this.fallback = new InMemoryCircuitBreaker(options);
  }

  private keys(key: string): [string, string, string] {
    return [`cb:erpnext:${key}:f`, `cb:erpnext:${key}:o`, `cb:erpnext:${key}:p`];
  }

  /**
   * Returns null when Redis could not answer, which the callers read as "fall back", not as
   * "closed" — losing Redis must not silently disable the breaker.
   */
  private async run(mode: string, key: string): Promise<[number, string] | null> {
    const [fKey, oKey, pKey] = this.keys(key);
    const args = [mode, String(Date.now()), String(this.threshold), String(this.cooldownMs)];

    try {
      const sha = await ensureScript(this.redis);
      return (await this.redis.evalsha(sha, 3, fKey, oKey, pKey, ...args)) as [number, string];
    } catch (error) {
      // NOSCRIPT: the server was restarted or the script evicted. Reload once, then give up and
      // let the in-memory fallback take over rather than looping.
      if (error instanceof Error && error.message.includes("NOSCRIPT")) {
        resetCircuitBreakerScript();
        try {
          const sha = await ensureScript(this.redis);
          return (await this.redis.evalsha(sha, 3, fKey, oKey, pKey, ...args)) as [number, string];
        } catch (retryError) {
          this.logger.warn({ err: retryError, mode }, "breaker script reload failed");
          return null;
        }
      }
      this.logger.warn({ err: error, mode }, "breaker state unavailable; using in-memory fallback");
      return null;
    }
  }

  async state(key: string): Promise<CircuitState> {
    const result = await this.run("peek", key);
    if (!result) return this.fallback.state(key);
    return result[1] as CircuitState;
  }

  async execute<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const acquired = await this.run("acquire", key);
    if (!acquired) return this.fallback.execute(key, fn);

    if (acquired[0] === 0) throw new CircuitOpenError(key);

    try {
      const result = await fn();
      await this.run("success", key);
      return result;
    } catch (error) {
      if (this.isFailure(error)) {
        await this.run("failure", key);
      } else {
        await this.run("success", key);
      }
      throw error;
    }
  }
}
