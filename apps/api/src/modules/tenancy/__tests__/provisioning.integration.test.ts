/**
 * Integration tests for tenant provisioning.
 *
 * These tests require a live PostgreSQL database (TEST_DATABASE_URL).
 * Run with: bun test apps/api/src/modules/tenancy/__tests__
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

import { createTestDatabase, type TestDatabase } from "../../../../tests/harness/database";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const describeIntegration = describe.skipIf(!integrationEnabled);

describeIntegration("Tenant provisioning integration", () => {
  let database: TestDatabase | null = null;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  test("provisioning_status column exists on schools", async () => {
    const result = await database!.sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'schools'
        AND column_name = 'provisioning_status'
    `;
    expect(result.length).toBe(1);
    expect(result[0].column_name).toBe("provisioning_status");
  });

  test("provisioning_status column exists on subscriptions", async () => {
    const result = await database!.sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'subscriptions'
        AND column_name = 'provisioning_status'
    `;
    expect(result.length).toBe(1);
    expect(result[0].column_name).toBe("provisioning_status");
  });

  test("student_cap column exists on subscriptions", async () => {
    const result = await database!.sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'subscriptions'
        AND column_name = 'student_cap'
    `;
    expect(result.length).toBe(1);
    expect(result[0].column_name).toBe("student_cap");
  });

  test("trial_expires_at column exists on subscriptions", async () => {
    const result = await database!.sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'subscriptions'
        AND column_name = 'trial_expires_at'
    `;
    expect(result.length).toBe(1);
    expect(result[0].column_name).toBe("trial_expires_at");
  });

  test("erpnext_site_configs table exists with RLS", async () => {
    const result = await database!.sql<
      { tablename: string; rowsecurity: boolean; forcerowsecurity: boolean }[]
    >`
      SELECT
        c.relname AS tablename,
        c.relrowsecurity AS rowsecurity,
        c.relforcerowsecurity AS forcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app'
        AND c.relname = 'erpnext_site_configs'
    `;
    expect(result.length).toBe(1);
    expect(result[0].rowsecurity).toBe(true);
    expect(result[0].forcerowsecurity).toBe(true);
  });

  test("provisioning_status enum type exists", async () => {
    const result = await database!.sql<{ typname: string }[]>`
      SELECT typname
      FROM pg_type
      WHERE typname = 'provisioning_status'
        AND typnamespace = 'app'::regnamespace
    `;
    expect(result.length).toBe(1);
    expect(result[0].typname).toBe("provisioning_status");
  });

  test("student_cap CHECK constraint enforces positive values", async () => {
    // This is a schema validation test — we verify the constraint exists.
    const result = await database!.sql<{ constraint_name: string; check_clause: string }[]>`
      SELECT
        con.conname AS constraint_name,
        pg_get_constraintdef(con.oid) AS check_clause
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app'
        AND c.relname = 'subscriptions'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) LIKE '%student_cap%'
    `;
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
