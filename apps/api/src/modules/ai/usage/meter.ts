import { AI_QUOTA_KEY_PREFIX, AI_QUOTA_PERIOD_GRACE_SECONDS } from "../config";

import type { RedisClient } from "../../../redis";

/**
 * Redis-metered monthly token budget for AI access (ST-155).
 *
 * One hash per (school, student, billing period) holds three fields: `used` (tokens the period has
 * consumed), `held` (tokens reserved by in-flight requests), and `reserved`/`reserved_amount`
 * (the single live reservation). The invariant -- `used + held <= budget` -- is enforced inside
 * atomic Lua scripts, so concurrent reserves serialize in Redis and can never over-commit the
 * budget. `used` therefore converges on a value at or below the budget no matter how many pods race.
 *
 * The meter keys on the AI subscription's billing window (via the entitlement's `currentPeriodStart`)
 * rather than a calendar month, so the budget resets at the renewal that actually starts a fresh
 * billing cycle. The counter key carries a TTL of `time to period end + grace`, which bounds the
 * keyspace and lets a commit that races the period boundary still land on the window it was
 * reserved against.
 *
 * Lifecycle, from the gate's point of view:
 *   1. `reserve` atomically holds `amount` tokens. A reservation is refused when `used + held +
 *      amount` would exceed the budget. Only one reservation can be live per key at a time; the
 *      gate guarantees this by admitting one in-flight request per student.
 *   2. The handler either `commit`s the actual tokens consumed, or the request fails and the gate
 *      `release`s the hold. Both are idempotent: settling a reservation that is no longer live is a
 *      no-op, so a double release from an error path cannot over-refund.
 *   3. `snapshot` reports the period's used/held/remaining for the usage endpoint.
 *
 * Durability: this Redis ledger gates the request. `app.ai_usage_meters` is the durable ledger the
 * AI handlers write on commit; it is deliberately not written here, because the gate must stay one
 * Redis round trip and the write shape belongs to the routes that produce usage (out of scope for
 * the gate).
 */

export interface AiReserveInput {
  schoolId: string;
  studentId: string;
  /** ISO billing window this reservation is charged to, from the entitlement resolution. */
  periodStart: string;
  periodEnd: string;
  /** Monthly token budget for this subscription's window. */
  budget: number;
  /** Tokens to hold while the request runs. */
  amount: number;
}

export interface AiReservation {
  ok: true;
  /** Opaque id that settles this reservation in commit()/release(). */
  reservationId: string;
  reservedTokens: number;
  /** Budget still available after this reservation (budget - used - held). */
  remaining: number;
}

export interface AiQuotaRefusal {
  ok: false;
  /** "exhausted": nothing is left. "insufficient": what is left cannot cover the reservation. */
  reason: "exhausted" | "insufficient";
  /** Tokens the period has already committed (used plus held by in-flight reservations). */
  currentUsage: number;
  budget: number;
  /** Seconds until the billing period ends; clients can send this as Retry-After. */
  retryAfterSeconds: number;
}

export type AiReservationResult = AiReservation | AiQuotaRefusal;

interface AiSettleBase {
  schoolId: string;
  studentId: string;
  periodStart: string;
  periodEnd: string;
  reservationId: string;
  /** Monthly token budget for this subscription's window; used to report the budget left after settling. */
  budget: number;
}

export interface AiCommitInput extends AiSettleBase {
  /** Actual tokens consumed by the request; must be <= the reserved amount. */
  consumedTokens: number;
}

export type AiReleaseInput = AiSettleBase;

export interface AiSettleResult {
  /** False when the reservation was not live (already settled) -- an idempotent no-op. */
  settled: boolean;
  /** Budget remaining after settling (budget - used - held). */
  remaining: number;
}

export interface AiSnapshotInput {
  schoolId: string;
  studentId: string;
  periodStart: string;
  periodEnd: string;
  budget: number;
}

export interface AiUsageSnapshot {
  /** False when no counter exists yet for this period -- nothing has been reserved or committed. */
  active: boolean;
  budget: number;
  /** Tokens definitively consumed this period. */
  usedTokens: number;
  /** Tokens held by the in-flight reservation, if any. */
  heldTokens: number;
  /** Budget not yet used or held. */
  remaining: number;
  /** ISO billing window this snapshot covers. */
  periodStart: string;
  periodEnd: string;
}

export interface AiTokenMeter {
  reserve(input: AiReserveInput): Promise<AiReservationResult>;
  commit(input: AiCommitInput): Promise<AiSettleResult>;
  release(input: AiReleaseInput): Promise<AiSettleResult>;
  snapshot(input: AiSnapshotInput): Promise<AiUsageSnapshot>;
}

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

/** A compact, collision-safe period key from the billing window's start date. */
export function aiQuotaPeriodKey(periodStart: string): string {
  return periodStart.slice(0, 10);
}

/** The Redis counter key for one (school, student, billing period). */
export function aiQuotaKey(schoolId: string, studentId: string, periodKey: string): string {
  return `${AI_QUOTA_KEY_PREFIX}:${schoolId}:${studentId}:${periodKey}`;
}

// ---------------------------------------------------------------------------
// Atomic Lua scripts
// ---------------------------------------------------------------------------

/**
 * Reserve `amount` tokens for one request.
 *
 * Returns `[allowed, reason, remaining, used, held]`:
 * - allowed: 1 the hold was placed, 0 it was refused.
 * - reason (when refused): 0 exhausted (nothing left), 1 insufficient (cannot cover the amount).
 * - remaining: budget left after the hold when allowed; current budget left when refused.
 */
const RESERVE_SCRIPT = `
local created = redis.call('EXISTS', KEYS[1]) == 0

local used = 0
local held = 0
if not created then
  used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
  held = tonumber(redis.call('HGET', KEYS[1], 'held') or '0')
end

local amount = tonumber(ARGV[1])
local budget = tonumber(ARGV[2])
local remaining = budget - used - held

if remaining < amount then
  local reason = remaining <= 0 and 0 or 1
  return {0, reason, remaining, used, held}
end

redis.call('HSET', KEYS[1], 'held', held + amount)
redis.call('HSET', KEYS[1], 'reserved', ARGV[3])
redis.call('HSET', KEYS[1], 'reserved_amount', amount)
if created then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return {1, 0, remaining - amount, used, held}
`;

/**
 * Move the live reservation's tokens from `held` into `used`.
 *
 * Returns `[settled, remaining]`; `settled` is 0 when the reservation is not live (already settled),
 * which makes commit idempotent. A consumed amount outside `[0, reserved]` is a programmer error and
 * returns `[-1, 0]` rather than corrupting the counter.
 */
const COMMIT_SCRIPT = `
if redis.call('HGET', KEYS[1], 'reserved') ~= ARGV[2] then
  return {0, 0}
end

local consumed = tonumber(ARGV[1])
local budget = tonumber(ARGV[3])
local reservedAmount = tonumber(redis.call('HGET', KEYS[1], 'reserved_amount') or '0')
if consumed < 0 or consumed > reservedAmount then
  return {-1, 0}
end

redis.call('HDEL', KEYS[1], 'reserved')
redis.call('HDEL', KEYS[1], 'reserved_amount')

local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0') + consumed
local held = math.max(0, tonumber(redis.call('HGET', KEYS[1], 'held') or '0') - reservedAmount)

redis.call('HSET', KEYS[1], 'used', used)
redis.call('HSET', KEYS[1], 'held', held)

return {1, budget - used - held}
`;

/**
 * Return the live reservation's tokens to the available budget without counting them as usage.
 *
 * Same shape and idempotency contract as COMMIT_SCRIPT.
 */
const RELEASE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'reserved') ~= ARGV[1] then
  return {0, 0}
end

local reservedAmount = tonumber(redis.call('HGET', KEYS[1], 'reserved_amount') or '0')
local budget = tonumber(ARGV[2])
redis.call('HDEL', KEYS[1], 'reserved')
redis.call('HDEL', KEYS[1], 'reserved_amount')

local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
local held = math.max(0, tonumber(redis.call('HGET', KEYS[1], 'held') or '0') - reservedAmount)

redis.call('HSET', KEYS[1], 'held', held)

return {1, budget - used - held}
`;

/**
 * Read the counter without mutating it.
 *
 * Returns `[exists, used, held, reserved, ttl]`; `reserved` is the live reservation id or empty,
 * `ttl` is the key's remaining lifetime in seconds (or -1 when it has none).
 */
const SNAPSHOT_SCRIPT = `
local exists = redis.call('EXISTS', KEYS[1]) == 1
local used = 0
local held = 0
local reserved = ''
local ttl = -1
if exists then
  used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
  held = tonumber(redis.call('HGET', KEYS[1], 'held') or '0')
  reserved = redis.call('HGET', KEYS[1], 'reserved') or ''
  ttl = redis.call('TTL', KEYS[1])
end
return {exists and 1 or 0, used, held, reserved, ttl}
`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function isNoScriptError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string" &&
    (err as { message: string }).message.includes("NOSCRIPT")
  );
}

function periodTtlSeconds(periodEnd: string): number {
  const remaining = Math.ceil((Date.parse(periodEnd) - Date.now()) / 1000);
  return Math.max(60, remaining + AI_QUOTA_PERIOD_GRACE_SECONDS);
}

function retryAfterSeconds(periodEnd: string): number {
  return Math.max(1, Math.ceil((Date.parse(periodEnd) - Date.now()) / 1000));
}

export function createAiTokenMeter({ redis }: { redis: RedisClient }): AiTokenMeter {
  const shas = new Map<string, string>();

  async function sha(script: string): Promise<string> {
    let loaded = shas.get(script);
    if (!loaded) {
      loaded = (await redis.script("LOAD", script)) as string;
      shas.set(script, loaded);
    }
    return loaded;
  }

  /** EVALSHA with a one-shot NOSCRIPT recovery, mirroring middleware/rateLimiter.ts. */
  async function evalScript<T>(script: string, args: (string | number)[]): Promise<T> {
    const loaded = await sha(script);
    try {
      return (await redis.evalsha(loaded, 1, ...args)) as T;
    } catch (err) {
      if (isNoScriptError(err)) {
        shas.delete(script);
        const reloaded = (await redis.script("LOAD", script)) as string;
        shas.set(script, reloaded);
        return (await redis.evalsha(reloaded, 1, ...args)) as T;
      }
      throw err;
    }
  }

  async function reserve(input: AiReserveInput): Promise<AiReservationResult> {
    const { schoolId, studentId, periodStart, periodEnd, budget, amount } = input;
    const key = aiQuotaKey(schoolId, studentId, aiQuotaPeriodKey(periodStart));
    const reservationId = crypto.randomUUID();

    const [allowed, reason, remaining, used, held] = (await evalScript<
      [number, number, number, number, number]
    >(RESERVE_SCRIPT, [key, amount, budget, reservationId, periodTtlSeconds(periodEnd)])) as [
      number,
      number,
      number,
      number,
      number,
    ];

    if (allowed === 1) {
      return { ok: true, reservationId, reservedTokens: amount, remaining };
    }

    return {
      ok: false,
      reason: reason === 1 ? "insufficient" : "exhausted",
      currentUsage: used + held,
      budget,
      retryAfterSeconds: retryAfterSeconds(periodEnd),
    };
  }

  async function commit(input: AiCommitInput): Promise<AiSettleResult> {
    const { schoolId, studentId, periodStart, reservationId, consumedTokens, budget } = input;
    const key = aiQuotaKey(schoolId, studentId, aiQuotaPeriodKey(periodStart));

    const [settled, remaining] = (await evalScript<[number, number]>(COMMIT_SCRIPT, [
      key,
      consumedTokens,
      reservationId,
      budget,
    ])) as [number, number];

    if (settled === -1) {
      throw new Error(
        `ai quota commit out of range: consumed ${consumedTokens} exceeds reservation (school ${schoolId}, student ${studentId})`,
      );
    }

    return { settled: settled === 1, remaining };
  }

  async function release(input: AiReleaseInput): Promise<AiSettleResult> {
    const { schoolId, studentId, periodStart, reservationId, budget } = input;
    const key = aiQuotaKey(schoolId, studentId, aiQuotaPeriodKey(periodStart));

    const [settled, remaining] = (await evalScript<[number, number]>(RELEASE_SCRIPT, [
      key,
      reservationId,
      budget,
    ])) as [number, number];

    return { settled: settled === 1, remaining };
  }

  async function snapshot(input: AiSnapshotInput): Promise<AiUsageSnapshot> {
    const { schoolId, studentId, periodStart, periodEnd, budget } = input;
    const key = aiQuotaKey(schoolId, studentId, aiQuotaPeriodKey(periodStart));

    const [exists, used, held] = (await evalScript<[number, number, number, string, number]>(
      SNAPSHOT_SCRIPT,
      [key],
    )) as [number, number, number, string, number];

    return {
      active: exists === 1,
      budget,
      usedTokens: used,
      heldTokens: held,
      remaining: budget - used - held,
      periodStart,
      periodEnd,
    };
  }

  return { reserve, commit, release, snapshot };
}
