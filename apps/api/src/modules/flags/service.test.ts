// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { cacheKey } from "../../cache";
import { createLogger } from "../../logger";

import { createFlagsService } from "./service";

import type { Database } from "../../db/client";

// ---------------------------------------------------------------------------
// Fake Redis that stores plain key→string entries in a Map.
// ---------------------------------------------------------------------------

interface FakeRedis {
  store: Map<string, string>;
  failGet?: boolean;
  failSet?: boolean;
}

function stubRedis(opts: { failGet?: boolean; failSet?: boolean } = {}): FakeRedis {
  return { store: new Map<string, string>(), ...opts };
}

// Minimal fake satisfying the `getCache`/`setCache` shape consumed by the service.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function redisLike(fake: FakeRedis): any {
  return {
    async get(key: string): Promise<string | null> {
      if (fake.failGet) throw new Error("redis get failed");
      return fake.store.get(key) ?? null;
    },
    async set(key: string, value: string, ex?: number): Promise<void> {
      if (fake.failSet) throw new Error("redis set failed");
      fake.store.set(key, value);
      void ex;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake database: only enough surface for `withTenantTx` + `resolveFlagOverride`.
// ---------------------------------------------------------------------------

interface FakeTxResult {
  school_id: string;
  flag_name: string;
  enabled: boolean;
}

function makeQueryResult(value: unknown) {
  const p = Promise.resolve(value);
  return {
    execute: () => p,
    then: <T>(onFulfilled: (_value: unknown) => T): Promise<T> => p.then(onFulfilled),
  };
}

/** A postgres.js-ish tagged template for one transaction. */
function stubTx(overrideRows: FakeTxResult[]) {
  return (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    // configureTenantTx runs `SELECT set_config(...)`, the override query reads feature_flags.
    return makeQueryResult(overrideRows);
  };
}

/**
 * postgres.js instances are callable functions: `selectDatabase` special-cases `typeof ===
 * "function"` and returns the client itself rather than reading a `.primary` pool member, so the
 * fake must be a function carrying a `.begin`.
 */
function stubDatabase(overrideRows: FakeTxResult[] = []): Database {
  const tx = stubTx(overrideRows);
  const client = (_strings: TemplateStringsArray, ..._values: unknown[]) =>
    makeQueryResult(overrideRows);
  client.begin = (fn: (sql: typeof tx) => Promise<unknown>) => fn(tx);
  return client as unknown as Database;
}

const logger = createLogger({ destination: () => undefined });
const schoolId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("createFlagsService", () => {
  describe("no context — registry / deployment default", () => {
    test("returns the registry default for a known flag with no ctx", async () => {
      const svc = createFlagsService({ database: null, redis: null, logger });
      expect(await svc.get("ai.llm")).toBe(false);
      expect(await svc.get("ai.rerank")).toBe(false);
    });

    test("deployment defaults override the registry default", async () => {
      const svc = createFlagsService({
        database: null,
        redis: null,
        logger,
        defaults: { "ai.llm": true },
      });
      expect(await svc.get("ai.llm")).toBe(true);
      expect(await svc.get("ai.rerank")).toBe(false);
    });
  });

  describe("no database — always returns the deployment default", () => {
    test("a per-tenant override row would exist but the database is null", async () => {
      const svc = createFlagsService({ database: null, redis: null, logger });
      expect(await svc.get("ai.llm", { schoolId })).toBe(false);
    });
  });

  describe("with a fake database — per-tenant override wins", () => {
    test("returns true when the school has an override row with enabled=true", async () => {
      const svc = createFlagsService({
        database: stubDatabase([{ school_id: schoolId, flag_name: "ai.llm", enabled: true }]),
        redis: null,
        logger,
      });
      expect(await svc.get("ai.llm", { schoolId })).toBe(true);
    });

    test("returns false when the school has an override row with enabled=false", async () => {
      const svc = createFlagsService({
        database: stubDatabase([{ school_id: schoolId, flag_name: "ai.llm", enabled: false }]),
        redis: null,
        logger,
        defaults: { "ai.llm": true },
      });
      expect(await svc.get("ai.llm", { schoolId })).toBe(false);
    });

    test("returns the deployment default when no override row exists", async () => {
      const svc = createFlagsService({
        database: stubDatabase(),
        redis: null,
        logger,
        defaults: { "ai.rerank": true },
      });
      expect(await svc.get("ai.rerank", { schoolId })).toBe(true);
    });
  });

  describe("Redis caching", () => {
    test("a cache hit skips the database entirely", async () => {
      const fake = stubRedis();
      const key = cacheKey(schoolId, "flags", "ai.llm");
      fake.store.set(key, JSON.stringify(true));
      const svc = createFlagsService({
        database: stubDatabase(),
        redis: redisLike(fake),
        logger,
      });
      expect(await svc.get("ai.llm", { schoolId })).toBe(true);
      expect(fake.store.get(key)).toBe(JSON.stringify(true));
    });

    test("cache-miss path writes the result back to Redis", async () => {
      const fake = stubRedis();
      const svc = createFlagsService({
        database: stubDatabase([{ school_id: schoolId, flag_name: "ai.rerank", enabled: true }]),
        redis: redisLike(fake),
        logger,
      });
      expect(await svc.get("ai.rerank", { schoolId })).toBe(true);
      expect(fake.store.get(cacheKey(schoolId, "flags", "ai.rerank"))).toBe(JSON.stringify(true));
    });

    test("Redis read failure falls back to the database", async () => {
      const fake = stubRedis({ failGet: true });
      const svc = createFlagsService({
        database: stubDatabase([{ school_id: schoolId, flag_name: "ai.llm", enabled: true }]),
        redis: redisLike(fake),
        logger,
      });
      expect(await svc.get("ai.llm", { schoolId })).toBe(true);
    });

    test("Redis write failure is tolerated — the value still returns", async () => {
      const fake = stubRedis({ failSet: true });
      const svc = createFlagsService({
        database: stubDatabase([{ school_id: schoolId, flag_name: "ai.llm", enabled: true }]),
        redis: redisLike(fake),
        logger,
      });
      expect(await svc.get("ai.llm", { schoolId })).toBe(true);
      expect(fake.store.get(cacheKey(schoolId, "flags", "ai.llm"))).toBeUndefined();
    });
  });

  describe("type safety", () => {
    test("unknown flag name fails the type check", async () => {
      const svc = createFlagsService({ database: null, redis: null, logger });
      // @ts-expect-error — "ai.bogus" is not in the registry
      await expect(svc.get("ai.bogus")).rejects.toThrow();
    });
  });
});
