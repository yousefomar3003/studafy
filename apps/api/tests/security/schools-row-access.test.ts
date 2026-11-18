/**
 * QA-016: one school cannot read or change another school's row in app.schools.
 *
 * app.schools had no row-level security and studafy_app held SELECT, INSERT and UPDATE on it. It
 * holds every school's contact email, verification token hash, Stripe/Tap customer ids and status,
 * so any app-layer IDOR on a school id could read those or suspend another school, with nothing in
 * the database to stop it. The table is now FORCE RLS: a tenant transaction sees only its own
 * school, and studafy_app can no longer write it (writes go through system transactions).
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/schools-row-access.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
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
let schoolA: string;
let schoolB: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  schoolA = (await createSchool(database.sql)).id;
  schoolB = (await createSchool(database.sql)).id;
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describeDb("app.schools row access from a tenant transaction (QA-016)", () => {
  test("school A cannot read school B's row", async () => {
    const rows = await withTenantTx(
      appDatabaseFor(database!.sql),
      { schoolId: schoolA },
      (tx) =>
        tx<{ id: string }[]>`
        SELECT id, email_verification_token_hash FROM app.schools WHERE id = ${schoolB}::uuid
      `,
    );
    expect(rows).toHaveLength(0);
  });

  test("school A still reads its own row", async () => {
    const rows = await withTenantTx(
      appDatabaseFor(database!.sql),
      { schoolId: schoolA },
      (tx) => tx<{ id: string }[]>`SELECT id FROM app.schools WHERE id = ${schoolA}::uuid`,
    );
    expect(rows.map((row) => row.id)).toEqual([schoolA]);
  });

  test("school A cannot change school B's status", async () => {
    const outcome = await withTenantTx(
      appDatabaseFor(database!.sql),
      { schoolId: schoolA },
      (tx) => tx`UPDATE app.schools SET status = 'suspended' WHERE id = ${schoolB}::uuid`,
    ).then(
      (result) => `updated ${result.count}`,
      (error: unknown) => (String(error).includes("permission denied") ? "denied" : String(error)),
    );
    expect(["denied", "updated 0"]).toContain(outcome);
    const [b] = await database!.sql<{ status: string }[]>`
      SELECT status::text AS status FROM app.schools WHERE id = ${schoolB}::uuid
    `;
    expect(b!.status).not.toBe("suspended");
  });
});
