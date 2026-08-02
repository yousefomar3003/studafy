import { DOMAIN_EVENTS } from "@studafy/constants";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import { claimEntitlementRows, markEntitlementRowsApplied } from "./claim";

import type { ClaimedEntitlementRow } from "./claim";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";

/**
 * The durable half of ST-133's cache invalidation.
 *
 * This is the component the <5s propagation SLA actually rests on. The API-side pub/sub subscriber is
 * faster but lossy — Redis pub/sub is fire-and-forget and the relay marks `relayed_at` whether or not
 * anyone was listening, so a pod restarting mid-deploy drops the message permanently. This consumer
 * claims the same outbox rows through its own cursor (`entitlement_applied_at`) and cannot lose one.
 *
 * Modelled on the email dispatcher, which is the one consumer style in this repo that demonstrably
 * runs in production. Claim, invalidate and mark all happen in a single transaction: a Redis failure
 * throws, the transaction rolls back, the cursor stays NULL and the next cycle retries. That makes
 * delivery at-least-once, which is safe because the invalidation is idempotent — the version guard
 * turns a repeat into a no-op.
 *
 * ## Known ceiling
 *
 * Like the email dispatcher, this enumerates schools per cycle and issues one claim per school,
 * because `app.outbox_events` is tenant-isolated and its policy reads `app.school_id` without
 * `missing_ok` — a cross-tenant claim is not expressible. Schools are processed in bounded-parallel
 * chunks rather than serially, which is an improvement on that precedent but not a fix. A
 * tenant-agnostic outbox claim path is its own ticket and would benefit both consumers.
 */

export interface EntitlementInvalidatorLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}

export interface EntitlementInvalidatorConfig {
  batchSize: number;
  pollIntervalMs: number;
  /** How many schools to claim from concurrently. Bounds pool usage on a large tenant list. */
  concurrency: number;
}

export interface EntitlementInvalidatorContext {
  db: Sql;
  redis: Redis;
  config: EntitlementInvalidatorConfig;
  logger: EntitlementInvalidatorLogger;
}

export interface EntitlementInvalidatorHandle {
  stop: () => void;
}

/**
 * Raise a cached entry to a version floor, keeping the entry present but bodyless.
 *
 * Mirrors `INVALIDATE_TO_FLOOR` in apps/api/src/modules/subscriptions/entitlements/cache.ts. Kept as
 * a second copy rather than an import because apps/workers cannot import from apps/api — the same
 * trade `apps/workers/src/db/audit.ts` documents for the audit emitter. The encoding it writes
 * (`<version>|`) is the contract between the two.
 *
 * Returns 1 when the floor moved, 0 when the stored entry was already at or above it. That is what
 * makes running this alongside the API's pub/sub subscriber a provable no-op rather than a race.
 */
const INVALIDATE_TO_FLOOR = `
local current = redis.call("GET", KEYS[1])
if current then
  local sep = string.find(current, "|", 1, true)
  if sep then
    local stored = tonumber(string.sub(current, 1, sep - 1))
    if stored and stored >= tonumber(ARGV[1]) then return 0 end
  end
end
redis.call("SET", KEYS[1], ARGV[1] .. "|", "EX", ARGV[2])
return 1
`;

/** Mirrors ENTITLEMENT_CACHE_TTL_SECONDS in apps/api. Redis runs noeviction: every write needs a TTL. */
const ENTITLEMENT_CACHE_TTL_SECONDS = 300;

/**
 * The cache key one claimed row invalidates, or null when the payload cannot be trusted.
 *
 * Returning null rather than throwing is deliberate: a malformed payload is a permanent condition, so
 * throwing would roll the batch back and re-claim the same unparseable row forever. It is logged and
 * marked applied instead.
 */
function resolveTarget(row: ClaimedEntitlementRow): { key: string; version: number } | null {
  const version = row.payload.entitlementsVersion;
  if (typeof version !== "number" || !Number.isFinite(version)) return null;

  if (row.event_name === DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED) {
    const schoolId = row.payload.schoolId;
    return typeof schoolId === "string" ? { key: `ent:${schoolId}`, version } : null;
  }

  if (row.event_name === DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED) {
    const studentId = row.payload.studentId;
    return typeof studentId === "string" ? { key: `ent:ai:${studentId}`, version } : null;
  }

  return null;
}

/**
 * One claim-invalidate-mark cycle for one school.
 *
 * Exported for tests, which drive it directly rather than racing the polling loop.
 *
 * @returns the number of rows applied.
 */
export async function processEntitlementSchool(
  ctx: EntitlementInvalidatorContext,
  schoolId: string,
): Promise<number> {
  return withSystemTenantTx(ctx.db, { schoolId }, async (tx) => {
    const rows = await claimEntitlementRows(tx, ctx.config.batchSize);
    if (rows.length === 0) return 0;

    for (const row of rows) {
      const target = resolveTarget(row);

      if (!target) {
        ctx.logger.warn(
          { school_id: schoolId, outbox_id: row.id, event_name: row.event_name },
          "entitlement event payload unusable; marking applied without invalidating",
        );
        continue;
      }

      // Throws on a Redis failure, which rolls the whole batch back including the cursor update
      // below. That is the at-least-once guarantee: nothing is marked consumed unless its
      // invalidation actually landed.
      await ctx.redis.eval(
        INVALIDATE_TO_FLOOR,
        1,
        target.key,
        String(target.version),
        String(ENTITLEMENT_CACHE_TTL_SECONDS),
      );
    }

    await markEntitlementRowsApplied(
      tx,
      rows.map((row) => row.id),
    );

    ctx.logger.info(
      { school_id: schoolId, applied: rows.length },
      "invalidated entitlement cache entries",
    );
    return rows.length;
  });
}

/** Process every school once, in bounded-parallel chunks. Exported for tests. */
export async function runEntitlementCycle(ctx: EntitlementInvalidatorContext): Promise<number> {
  const schoolIds = await loadSchoolIds(ctx.db);
  let applied = 0;

  for (let index = 0; index < schoolIds.length; index += ctx.config.concurrency) {
    const chunk = schoolIds.slice(index, index + ctx.config.concurrency);
    const results = await Promise.allSettled(
      chunk.map((schoolId) => processEntitlementSchool(ctx, schoolId)),
    );

    for (const [offset, result] of results.entries()) {
      if (result.status === "fulfilled") {
        applied += result.value;
        continue;
      }
      // One school's failure must not stop the others: its rows stay unapplied and the next cycle
      // retries them.
      ctx.logger.error(
        { err: result.reason, school_id: chunk[offset] },
        "entitlement invalidation cycle failed for school",
      );
    }
  }

  return applied;
}

export function startEntitlementInvalidator(
  ctx: EntitlementInvalidatorContext,
): EntitlementInvalidatorHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const applied = await runEntitlementCycle(ctx);
        // Only idle when there was nothing to do. A full batch means more is waiting, and sleeping on
        // it would turn a backlog into a multiple of the poll interval.
        if (applied === 0) {
          await new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ctx.config.pollIntervalMs);
          });
        }
      } catch (err) {
        ctx.logger.error({ err }, "entitlement invalidator cycle failed");
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ctx.config.pollIntervalMs);
        });
      }
    }
  };

  void loop();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
