/**
 * getAccountProfile — the service behind GET /api/account/profile.
 *
 * Integration tests that require a live PostgreSQL instance; each runs the service inside a real
 * tenant transaction (withTenantTx), so RLS applies exactly as it does for the route.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/account/__tests__/profile-service.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createSchool,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { getAccountProfile } from "../profile-service";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

function resolveProfile(schoolId: string, userId: string) {
  return withTenantTx(db.sql, { schoolId, userId }, (tx) =>
    getAccountProfile(tx, schoolId, userId),
  );
}

describeDb("getAccountProfile", () => {
  test("returns the caller's name, email and school", async () => {
    const school = await createSchool(db.sql, { name: "Al-Noor Academy" });
    const user = await createUser(db.sql, school.id, { displayName: "Fatima Al-Sabah" });

    const profile = await resolveProfile(school.id, user.id);

    expect(profile).toEqual({
      user_id: user.id,
      display_name: "Fatima Al-Sabah",
      email: user.email,
      member_ids: [],
      deletion_due_at: null,
      deletion_requires_member_credentials: false,
      school_id: school.id,
      school_name: "Al-Noor Academy",
    });
  });

  test("returns undefined for a user who belongs to another school", async () => {
    const home = await createSchool(db.sql);
    const other = await createSchool(db.sql);
    const user = await createUser(db.sql, other.id);

    expect(await resolveProfile(home.id, user.id)).toBeUndefined();
  });
});
