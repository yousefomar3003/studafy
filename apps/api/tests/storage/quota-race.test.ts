/**
 * QA-037: concurrent uploads near the cap cannot together exceed it.
 *
 * reserveStorage read the meter (a plain SELECT), compared, then incremented. N confirms at 9.9 of
 * 10 GB all read 9.9, all passed and all counted. The reservation now holds a per-school
 * transaction lock across the check and the increment.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/storage/quota-race.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import { getStorageUsage } from "../../src/modules/storage/quota-service";
import { reserveStorage } from "../../src/modules/storage/staged-promotion";
import {
  appDatabaseFor,
  createSchool,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let schoolId: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  schoolId = (await createSchool(database.sql)).id;
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describeDb("storage quota under concurrent reservations (QA-037)", () => {
  test("five parallel reservations with room for two: exactly two succeed", async () => {
    const db = appDatabaseFor(database!.sql);
    const tenant = { schoolId };
    const { capBytes } = await withTenantTx(db, tenant, (tx) => getStorageUsage(tx));
    const unit = 1024 * 1024;
    // Room for two and a half units.
    await withTenantTx(
      db,
      tenant,
      (tx) => tx`SELECT app.set_storage_usage(${capBytes - 2.5 * unit})`,
    );

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        withTenantTx(db, tenant, async (tx) => {
          const reserved = await reserveStorage(tx, unit);
          // Hold the transaction open a moment, as a real confirm's would be while others check.
          await tx`SELECT pg_sleep(0.05)`;
          return reserved;
        }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const { bytesUsed } = await withTenantTx(db, tenant, (tx) => getStorageUsage(tx));
    expect(bytesUsed).toBeLessThanOrEqual(capBytes);
  });
});
