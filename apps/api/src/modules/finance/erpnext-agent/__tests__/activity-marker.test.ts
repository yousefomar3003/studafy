/**
 * The finance activity and wake marker (activity-marker.ts) and its hook in TenantErpNextFactory:
 * throttled to once an hour per school through Redis, a wake asked for only when the site exists and
 * sleeps, fail open on Redis and database failures, and never awaited by the finance request.
 *
 * The marker's own behaviour runs against a real migrated database and real Redis:
 *
 *   TEST_DATABASE_URL=postgres://... TEST_REDIS_URL=redis://127.0.0.1:6390 \
 *     bun test src/modules/finance/erpnext-agent
 *
 * The factory hook is tested with injected fakes and runs everywhere.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createSchool,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../../../../../tests/harness";
import { createLogger } from "../../../../logger";
import { createRedisClient } from "../../../../redis";
import { TenantErpNextFactory } from "../../client/tenant-client";
import {
  FINANCE_ACTIVITY_THROTTLE_SECONDS,
  financeActivityKey,
  FinanceActivityMarker,
} from "../activity-marker";

import type { TestDatabase } from "../../../../../tests/harness";
import type { Database } from "../../../../db/client";
import type { RedisClient } from "../../../../redis";
import type { ErpNextCredentialResolver } from "../../client/credential-resolver";
import type { ActivityMarkerRedis } from "../activity-marker";
import type { TransactionSql } from "postgres";

const redisUrl = process.env.TEST_REDIS_URL;
const describeDb = integrationEnabled && redisUrl ? describe : describe.skip;

const logLines: string[] = [];
const logger = createLogger({ destination: (line: string) => void logLines.push(line) });

let db: TestDatabase;
let redis: RedisClient | undefined;

beforeAll(async () => {
  if (!integrationEnabled || !redisUrl) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  redis = createRedisClient({ url: redisUrl, logger });
  await redis.connect();
}, 120_000);

afterAll(async () => {
  await redis?.quit();
  if (db?.cleanup) await db.cleanup();
});

interface SiteState {
  siteCreated: boolean;
  schedulerEnabled: boolean;
}

/** A school with a completed site row in the given state, and no throttle key. */
async function school(state: SiteState): Promise<string> {
  const created = await createSchool(db.sql);
  await db.sql`
    INSERT INTO app.erpnext_site_configs (
      school_id, site_name, company_name, company_abbr, status, site_created_at, scheduler_enabled
    ) VALUES (
      ${created.id}::uuid, ${`${created.slug}.erpnext.test`}, 'Company', 'TEST', 'completed',
      ${state.siteCreated ? new Date(Date.now() - 86_400_000) : null}, ${state.schedulerEnabled}
    )
  `;
  await redis!.del(financeActivityKey(created.id));
  return created.id;
}

async function site(schoolId: string) {
  const [row] = await db.sql<
    {
      last_finance_activity_at: Date | null;
      wake_requested_at: Date | null;
      updated_at: Date;
      created_at: Date;
    }[]
  >`
    SELECT last_finance_activity_at, wake_requested_at, updated_at, created_at
    FROM app.erpnext_site_configs WHERE school_id = ${schoolId}::uuid
  `;
  return row!;
}

function marker(overrides: { redis?: ActivityMarkerRedis; database?: Database } = {}) {
  return new FinanceActivityMarker({
    database: overrides.database ?? db.sql,
    redis: overrides.redis ?? redis!,
    logger,
  });
}

describeDb("FinanceActivityMarker", () => {
  test("a sleeping site: records the activity and asks for a wake, without touching updated_at", async () => {
    const schoolId = await school({ siteCreated: true, schedulerEnabled: false });
    const before = await site(schoolId);

    expect(await marker().mark(schoolId)).toBe(true);

    const after = await site(schoolId);
    expect(after.last_finance_activity_at).not.toBeNull();
    expect(after.wake_requested_at).not.toBeNull();
    expect(after.updated_at).toEqual(before.updated_at);
  });

  test("an awake site: records the activity, asks for no wake", async () => {
    const schoolId = await school({ siteCreated: true, schedulerEnabled: true });
    expect(await marker().mark(schoolId)).toBe(true);
    const after = await site(schoolId);
    expect(after.last_finance_activity_at).not.toBeNull();
    expect(after.wake_requested_at).toBeNull();
  });

  test("a site not created yet: records the activity, asks for no wake", async () => {
    const schoolId = await school({ siteCreated: false, schedulerEnabled: false });
    expect(await marker().mark(schoolId)).toBe(true);
    const after = await site(schoolId);
    expect(after.last_finance_activity_at).not.toBeNull();
    expect(after.wake_requested_at).toBeNull();
  });

  test("throttled: one write per school per hour, through SET NX EX 3600", async () => {
    const schoolId = await school({ siteCreated: true, schedulerEnabled: true });
    const other = await school({ siteCreated: true, schedulerEnabled: true });

    expect(await marker().mark(schoolId)).toBe(true);
    const ttl = await redis!.ttl(financeActivityKey(schoolId));
    expect(ttl).toBeGreaterThan(FINANCE_ACTIVITY_THROTTLE_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(3600);

    // Wind the recorded time back: a second write within the hour would move it forward again.
    await db.sql`
      UPDATE app.erpnext_site_configs SET last_finance_activity_at = '2026-01-01T00:00:00Z'
      WHERE school_id = ${schoolId}::uuid
    `;
    expect(await marker().mark(schoolId)).toBe(false);
    expect((await site(schoolId)).last_finance_activity_at?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );

    // The throttle is per school.
    expect(await marker().mark(other)).toBe(true);
  });

  test("fail open: Redis down skips the write without throwing", async () => {
    const schoolId = await school({ siteCreated: true, schedulerEnabled: false });
    const broken: ActivityMarkerRedis = {
      set: (() => Promise.reject(new Error("ECONNREFUSED"))) as ActivityMarkerRedis["set"],
      del: (() => Promise.reject(new Error("ECONNREFUSED"))) as ActivityMarkerRedis["del"],
    };
    logLines.length = 0;

    expect(await marker({ redis: broken }).mark(schoolId)).toBe(false);

    expect((await site(schoolId)).last_finance_activity_at).toBeNull();
    expect(logLines.some((line) => line.includes("finance activity throttle unavailable"))).toBe(
      true,
    );
  });

  test("fail open: a database failure is logged, and the throttle is released for a retry", async () => {
    const schoolId = await school({ siteCreated: true, schedulerEnabled: false });
    const failing = {
      begin: () => Promise.reject(new Error("connection terminated")),
    } as unknown as Database;
    logLines.length = 0;

    expect(await marker({ database: failing }).mark(schoolId)).toBe(false);

    expect(logLines.some((line) => line.includes("finance activity marker failed"))).toBe(true);
    expect(await redis!.exists(financeActivityKey(schoolId))).toBe(0);
    // The next request writes.
    expect(await marker().mark(schoolId)).toBe(true);
  });

  test("waits behind a transaction that holds the row, then writes once it commits", async () => {
    const schoolId = await school({ siteCreated: true, schedulerEnabled: false });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Like the credential resolver marking the site completed inside a finance request.
    const request = db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM app.erpnext_site_configs WHERE school_id = ${schoolId}::uuid FOR UPDATE`;
      locked();
      await held;
    });
    await isLocked;

    const marking = marker().mark(schoolId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await site(schoolId)).last_finance_activity_at).toBeNull();

    release();
    await request;
    expect(await marking).toBe(true);
    expect((await site(schoolId)).wake_requested_at).not.toBeNull();
  });
});

describe("TenantErpNextFactory activity hook", () => {
  const resolver: ErpNextCredentialResolver = {
    resolve: () =>
      Promise.resolve({
        baseUrl: "http://erpnext.test",
        apiKey: "k:s",
        siteHost: "a.erpnext.test",
      }),
  };
  const tx = {} as TransactionSql;
  const schoolId = "11111111-1111-4111-8111-111111111111";

  test("a finance request records activity for its school, once per client built", async () => {
    const marked: string[] = [];
    const factory = new TenantErpNextFactory({
      resolver,
      logger,
      activity: { mark: (id) => Promise.resolve(void marked.push(id)) },
    });

    await factory.forSchool(tx, schoolId);
    expect(marked).toEqual([schoolId]);
  });

  test("background work opts out", async () => {
    const marked: string[] = [];
    const factory = new TenantErpNextFactory({
      resolver,
      logger,
      activity: { mark: (id) => Promise.resolve(void marked.push(id)) },
    });

    await factory.forSchool(tx, schoolId, { recordActivity: false });
    expect(marked).toEqual([]);
  });

  test("never waits on the marker, and never fails because of it", async () => {
    const hanging = new TenantErpNextFactory({
      resolver,
      logger,
      activity: { mark: () => new Promise(() => undefined) },
    });
    const rejecting = new TenantErpNextFactory({
      resolver,
      logger,
      activity: { mark: () => Promise.reject(new Error("boom")) },
    });

    await expect(hanging.forSchool(tx, schoolId)).resolves.toBeDefined();
    await expect(rejecting.forSchool(tx, schoolId)).resolves.toBeDefined();
  });

  test("a site that does not resolve records nothing", async () => {
    const marked: string[] = [];
    const factory = new TenantErpNextFactory({
      resolver: { resolve: () => Promise.reject(new Error("not provisioned")) },
      logger,
      activity: { mark: (id) => Promise.resolve(void marked.push(id)) },
    });

    await expect(factory.forSchool(tx, schoolId)).rejects.toThrow("not provisioned");
    expect(marked).toEqual([]);
  });
});
