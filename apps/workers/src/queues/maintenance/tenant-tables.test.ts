/**
 * Integration test: discoverTenantTables must agree with the live catalog. Skipped without
 * TEST_DATABASE_URL, the same convention apps/workers/src/queues/entitlements/__tests__ uses.
 */
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { discoverTenantTables } from "./tenant-tables";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dbTest = test.skipIf(!enabled);

let db: Sql | undefined;

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 2, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

describe("discoverTenantTables", () => {
  dbTest("finds every real tenant table, and nothing global or partitioned", async () => {
    const tables = await discoverTenantTables(db!);
    const names = tables.map((t) => t.tableName);

    // Verified tenant-scoped tables from real migrations.
    expect(names).toContain("students");
    expect(names).toContain("users");
    expect(names).toContain("subscriptions");
    expect(names).toContain("data_subject_requests");

    // Verified globals (no school_id at all, per db/policies/rls-coverage.ts's approved_globals)
    // must never appear.
    expect(names).not.toContain("schools");
    expect(names).not.toContain("countries");
    expect(names).not.toContain("security_events");
    expect(names).not.toContain("billing_events");

    // No duplicates, and every partition-child row is folded under its parent's name (this asserts
    // NOT c.relispartition held -- a partitioned family like audit_logs must appear exactly once).
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n === "audit_logs")).toHaveLength(1);
  });
});
