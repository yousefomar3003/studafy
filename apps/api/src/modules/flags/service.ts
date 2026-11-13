import { flagDefault } from "@studafy/constants";

import { cacheKey, getCache, setCache, singleFlight } from "../../cache";
import { withTenantTx } from "../../db/tenant-tx";

import { FLAGS_CACHE_TTL_SECONDS } from "./config";
import { resolveFlagOverride } from "./resolve";

import type { Database, DatabasePools } from "../../db/client";
import type { Logger } from "../../logger";
import type { RedisClient } from "../../redis";
import type { FlagName } from "@studafy/constants";

/**
 * Feature-flag evaluation service.
 *
 * Resolves a flag to the effective value for one tenant under this precedence, highest first:
 *
 *   1. a per-tenant override row in `app.feature_flags` (Redis-cached, TTL-bounded), or
 *   2. a deployment-level default injected at bootstrap (e.g. `AI_LLM_ENABLED`), or
 *   3. the registry default in `@studafy/constants`' `FEATURE_FLAGS`.
 *
 * See docs/database/feature-flags-data-model.md for the contract and the propagation guarantee:
 * the cache TTL (`FLAGS_CACHE_TTL_SECONDS`, 10s) is what makes a flag flip land in <30s across a
 * fleet with no deploy.
 *
 * The read path fails open on Redis — a cache error is logged and the value is resolved from the
 * database, mirroring the entitlement service's posture: a flag must never take down the request
 * it guards. There is deliberately no in-process memo beyond `singleFlight`: the hot path is one
 * Redis GET per (flag, school), and these flags guard low-frequency AI surfaces, not the login
 * path.
 */

export interface FlagEvaluationContext {
  schoolId: string;
}

export interface FlagsService {
  /**
   * Evaluate one flag.
   *
   * With a `schoolId`, a per-tenant override (DB, Redis-cached) beats every default. Without one,
   * or when no database is available, the deployment/registry default answers — the platform-level
   * value any non-tenant consumer needs.
   *
   * `FlagName` is derived from the registry, so an unknown flag is a type error, not a runtime
   * undefined.
   */
  get(name: FlagName, ctx?: FlagEvaluationContext): Promise<boolean>;
}

export interface CreateFlagsServiceOptions {
  /** `null` (tests, the OpenAPI generator) disables override resolution; defaults always answer. */
  database: Database | DatabasePools | null;
  /** `null` disables caching; every evaluation resolves from the database. */
  redis: RedisClient | null;
  logger: Logger;
  /**
   * Deployment-level defaults, layered over the registry's `defaultValue`s. Threaded from the
   * environment (e.g. `{ "ai.llm": env.AI_LLM_ENABLED }`), so flipping a fleet-wide default is an
   * env change. `Partial` over `FlagName` keeps a mistyped key a type error.
   */
  defaults?: Partial<Record<FlagName, boolean>>;
}

export function createFlagsService(options: CreateFlagsServiceOptions): FlagsService {
  const { database, redis, logger, defaults = {} } = options;

  function defaultFor(name: FlagName): boolean {
    return defaults[name] ?? flagDefault(name);
  }

  async function load(schoolId: string, name: FlagName): Promise<boolean> {
    const key = cacheKey(schoolId, "flags", name);

    // Collapse concurrent misses for the same school/flag in this process into one DB query —
    // per-process only, exactly as the entitlement service's singleFlight is. Re-check the cache
    // inside the flight: the caller that opened it may have been queued behind a writer that has
    // since populated the key.
    return singleFlight(key, async () => {
      if (redis) {
        try {
          const cached = await getCache<boolean>(redis, key);
          if (cached !== null) return cached;
        } catch (err) {
          logger.warn(
            { err, school_id: schoolId, flag: name },
            "feature-flag cache recheck failed; reading database",
          );
        }
      }

      const effective = database
        ? await withTenantTx(database, { schoolId }, (tx) => resolveFlagOverride(tx, name)).then(
            (override) => override ?? defaultFor(name),
          )
        : defaultFor(name);

      if (redis) {
        try {
          await setCache(redis, key, effective, FLAGS_CACHE_TTL_SECONDS);
        } catch (err) {
          logger.warn({ err, school_id: schoolId, flag: name }, "feature-flag cache write failed");
        }
      }

      return effective;
    });
  }

  async function get(name: FlagName, ctx?: FlagEvaluationContext): Promise<boolean> {
    if (!ctx) return defaultFor(name);

    if (redis) {
      try {
        const cached = await getCache<boolean>(redis, cacheKey(ctx.schoolId, "flags", name));
        if (cached !== null) return cached;
      } catch (err) {
        logger.warn(
          { err, school_id: ctx.schoolId, flag: name },
          "feature-flag cache read failed; reading database",
        );
      }
    }

    return load(ctx.schoolId, name);
  }

  return { get };
}
