// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createReadinessProbe } from "./readiness";

import type { Database } from "./db";
import type { StorageService } from "./lib/storage";
import type { RedisClient } from "./redis";

/** A database fake: checkDatabase() runs `select 1` through the tagged-template callable. */
function database(healthy: boolean): Database {
  const query = async () => {
    if (!healthy) throw new Error("database down");
  };
  return query as unknown as Database;
}

const healthyRedis = { ping: async () => "PONG" } as unknown as RedisClient;

const downRedis = {
  ping: async () => {
    throw new Error("redis down");
  },
} as unknown as RedisClient;

const hangingRedis = { ping: () => new Promise<string>(() => undefined) } as unknown as RedisClient;

function storage(healthy: boolean): StorageService {
  return { check: async () => healthy } as unknown as StorageService;
}

describe("createReadinessProbe", () => {
  test("reports ready when every configured dependency answers", async () => {
    const probe = createReadinessProbe({
      database: database(true),
      readDatabase: database(true),
      redis: healthyRedis,
      storage: storage(true),
      timeoutMs: 1_000,
    });

    await expect(probe()).resolves.toBe(true);
  });

  test("treats absent dependencies as healthy, like checkRedis/checkDatabase", async () => {
    const probe = createReadinessProbe({
      database: null,
      readDatabase: null,
      redis: null,
      storage: null,
      timeoutMs: 1_000,
    });

    await expect(probe()).resolves.toBe(true);
  });

  test("reports not-ready when the database is down", async () => {
    const probe = createReadinessProbe({
      database: database(false),
      readDatabase: database(true),
      redis: healthyRedis,
      storage: storage(true),
      timeoutMs: 1_000,
    });

    await expect(probe()).resolves.toBe(false);
  });

  test("reports not-ready when Redis is down", async () => {
    const probe = createReadinessProbe({
      database: database(true),
      readDatabase: database(true),
      redis: downRedis,
      storage: storage(true),
      timeoutMs: 1_000,
    });

    await expect(probe()).resolves.toBe(false);
  });

  test("reports not-ready when storage is down", async () => {
    const probe = createReadinessProbe({
      database: database(true),
      readDatabase: database(true),
      redis: healthyRedis,
      storage: storage(false),
      timeoutMs: 1_000,
    });

    await expect(probe()).resolves.toBe(false);
  });

  test("flips not-ready within the timeout when a dependency hangs", async () => {
    const probe = createReadinessProbe({
      database: database(true),
      readDatabase: database(true),
      redis: hangingRedis,
      storage: storage(true),
      timeoutMs: 25,
    });

    const started = Date.now();
    await expect(probe()).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
