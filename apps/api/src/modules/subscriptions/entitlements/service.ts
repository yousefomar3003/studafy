import { singleFlight } from "../../../cache";
import { withTenantTx } from "../../../db/tenant-tx";

import {
  aiEntitlementCacheKey,
  entitlementCacheKey,
  readEntitlementEntry,
  readEntitlementPair,
  writeEntitlementEntryIfNewer,
} from "./cache";
import { resolveAiEntitlement, resolveSchoolEntitlement } from "./resolve";
import { GENESIS_ENTITLEMENTS_VERSION } from "./version";

import type { AiEntitlement, SchoolEntitlement } from "./resolve";
import type { Database, DatabasePools } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { RedisClient } from "../../../redis";

/**
 * The entitlement service (ST-133): cache-aside resolution with stampede protection.
 *
 * Reads go to Redis first and fall back to one indexed database query. Writes are version-guarded, so
 * a slow reader can never overwrite a fresher entry -- see ./cache.ts.
 */
export interface EntitlementService {
  /** The school's entitlement: active flag, plan code, quota ceilings. */
  school(schoolId: string): Promise<SchoolEntitlement>;
  /** One student's AI entitlement. False whenever the school is not active. */
  ai(schoolId: string, studentId: string): Promise<AiEntitlement>;
  /**
   * The school's current entitlement version. The JWT middleware's entry point, and the reason the
   * hot path is one Redis GET: a floor marker answers this without touching Postgres at all.
   */
  currentVersion(schoolId: string): Promise<number>;
}

export interface EntitlementServiceDeps {
  database: Database | DatabasePools;
  /**
   * `null` disables caching and resolves from the database every time. Dev, tests and the OpenAPI
   * generator all run without Redis; correctness is unaffected, only cost.
   */
  redis: RedisClient | null;
  logger: Logger;
}

export function createEntitlementService(deps: EntitlementServiceDeps): EntitlementService {
  const { database, redis, logger } = deps;

  /**
   * Resolve the school entry from the database and write it back.
   *
   * Wrapped in `singleFlight` keyed on the cache key, so N concurrent misses in this process collapse
   * to one query. That is per-process, not cluster-wide: `singleFlight` is an in-memory Map, not a
   * Redis lock. With M pods a cold key costs M single-row primary-key reads rather than N x M. A
   * distributed lock would add two round trips plus a lock-expiry failure mode to the hot path to
   * protect a query that is already a point lookup, so it is deliberately not used here.
   */
  async function loadSchool(schoolId: string): Promise<SchoolEntitlement> {
    const key = entitlementCacheKey(schoolId);

    return singleFlight(key, async () => {
      // Re-check inside the flight: the request that opened it may have been queued behind a writer
      // that has since populated the key.
      if (redis) {
        try {
          const entry = await readEntitlementEntry<SchoolEntitlement>(redis, key);
          if (entry?.value) return entry.value;
        } catch (err) {
          logger.warn({ err, school_id: schoolId }, "entitlement cache recheck failed");
        }
      }

      const resolved = await withTenantTx(database, { schoolId }, (tx) =>
        resolveSchoolEntitlement(tx, schoolId),
      );

      if (redis) {
        try {
          await writeEntitlementEntryIfNewer(redis, key, resolved.version, resolved);
        } catch (err) {
          logger.warn({ err, school_id: schoolId }, "entitlement cache write failed");
        }
      }

      return resolved;
    });
  }

  async function school(schoolId: string): Promise<SchoolEntitlement> {
    if (redis) {
      try {
        const entry = await readEntitlementEntry<SchoolEntitlement>(
          redis,
          entitlementCacheKey(schoolId),
        );
        if (entry?.value) return entry.value;
      } catch (err) {
        logger.warn(
          { err, school_id: schoolId },
          "entitlement cache read failed; querying database",
        );
      }
    }

    return loadSchool(schoolId);
  }

  async function ai(schoolId: string, studentId: string): Promise<AiEntitlement> {
    const schoolKey = entitlementCacheKey(schoolId);
    const aiKey = aiEntitlementCacheKey(studentId);

    if (redis) {
      try {
        const pair = await readEntitlementPair<SchoolEntitlement, AiEntitlement>(
          redis,
          schoolKey,
          aiKey,
        );

        // Both bodies present AND the AI verdict was computed against the school version currently in
        // force. A mismatch means the school moved since -- possibly in a way that cascaded no AI
        // rows and so emitted no AI event at all -- and the cached verdict cannot be trusted.
        if (
          pair.ai?.value &&
          pair.school?.value &&
          pair.ai.value.schoolVersion === pair.school.version
        ) {
          return pair.ai.value;
        }
      } catch (err) {
        logger.warn(
          { err, school_id: schoolId, student_id: studentId },
          "ai entitlement cache read failed; querying database",
        );
      }
    }

    return singleFlight(aiKey, async () => {
      const resolved = await withTenantTx(database, { schoolId }, (tx) =>
        resolveAiEntitlement(tx, schoolId, studentId),
      );

      if (redis) {
        try {
          // Both entries, from the one query, so the AI entry's schoolVersion provably matches the
          // school entry written beside it. Version-guarded, so neither can move a fresher entry back.
          await Promise.all([
            writeEntitlementEntryIfNewer(
              redis,
              schoolKey,
              resolved.school.version,
              resolved.school,
            ),
            writeEntitlementEntryIfNewer(redis, aiKey, resolved.ai.version, resolved.ai),
          ]);
        } catch (err) {
          logger.warn(
            { err, school_id: schoolId, student_id: studentId },
            "ai entitlement cache write failed",
          );
        }
      }

      return resolved.ai;
    });
  }

  async function currentVersion(schoolId: string): Promise<number> {
    if (redis) {
      // Deliberately not wrapped in try/catch. Unlike the read paths above -- where a Redis failure
      // can fall through to the database and still answer correctly -- this value gates
      // authentication, and the middleware fails closed on a throw. Swallowing the error here would
      // silently accept tokens of unknown freshness, which is the failure ST-133 exists to remove.
      // See the fail-closed rationale in middleware/jwtAuth.ts.
      const entry = await readEntitlementEntry<SchoolEntitlement>(
        redis,
        entitlementCacheKey(schoolId),
      );
      // A floor marker has no body but a trustworthy version -- that is the whole point of writing
      // one on invalidation rather than deleting.
      if (entry) return entry.version;
    }

    const resolved = await loadSchool(schoolId);
    return resolved.version ?? GENESIS_ENTITLEMENTS_VERSION;
  }

  return { school, ai, currentVersion };
}
