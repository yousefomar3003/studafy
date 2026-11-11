/**
 * getAccountProfile — the service behind GET /api/account/profile.
 *
 * Integration tests that require a live PostgreSQL instance; each runs the service inside a real
 * tenant transaction (withTenantTx), so RLS applies exactly as it does for the route.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/account/__tests__/profile-service.test.ts
 */

import { LEGAL_DOCUMENT_VERSIONS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  createSchool,
  createStudent,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { getAccountProfile } from "../profile-service";

import type { TransactionSql } from "postgres";

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

async function asAdmin(schoolId: string | null, fn: (tx: TransactionSql) => Promise<unknown>) {
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await fn(tx);
  });
}

/** A live AI add-on for the student, and (for a store purchase) the billing event naming the store. */
async function aiAddon(
  schoolId: string,
  studentId: string,
  options: { store?: "apple" | "google"; stripe?: string; ended?: boolean },
) {
  await asAdmin(
    schoolId,
    (tx) => tx`
      INSERT INTO app.ai_subscriptions (
        school_id, student_id, status, current_period_start, current_period_end, stripe_subscription_id
      ) VALUES (
        ${schoolId}::uuid, ${studentId}::uuid,
        ${options.ended ? "expired" : "active"}::app.subscription_status,
        now() - interval '10 days',
        ${options.ended ? tx`now() - interval '1 day'` : tx`now() + interval '20 days'`},
        ${options.stripe ?? null}
      )
    `,
  );
  if (!options.store) return;
  const ref = `${options.store}-${crypto.randomUUID()}`;
  await asAdmin(
    null,
    (tx) => tx`
      INSERT INTO app.billing_events (
        provider, provider_event_id, event_type, effective_at, payload, status, attempt_count, processed_at
      ) VALUES (
        ${options.store!}, ${`${options.store}:purchase:${ref}`}, 'purchased', now() - interval '10 days',
        ${tx.json({ store_ref: ref, metadata: { school_id: schoolId, student_id: studentId } })},
        'processed', 1, now()
      )
    `,
  );
}

async function linkParent(schoolId: string, parentUserId: string, studentId: string) {
  await asAdmin(schoolId, async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}::uuid, 'Store subscription family', ${parentUserId}::uuid)
      RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${parentUserId}::uuid, ${studentId}::uuid, 'mother')
    `;
  });
}

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
      active_store_subscriptions: [],
      // Test users are created having accepted the current documents (tests/harness/factories.ts).
      terms_version: LEGAL_DOCUMENT_VERSIONS.terms,
      privacy_version: LEGAL_DOCUMENT_VERSIONS.privacy,
      legal_accepted_at: expect.any(Date),
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

  describe("active_store_subscriptions", () => {
    test("lists a student's own App Store subscription", async () => {
      const school = await createSchool(db.sql);
      const student = await createStudent(db.sql, school.id);
      await assignRole(db.sql, school.id, student.userId, "STUDENT");
      await aiAddon(school.id, student.id, { store: "apple" });

      const profile = await resolveProfile(school.id, student.userId);

      expect(profile?.active_store_subscriptions).toEqual([
        { platform: "app_store", for_child: false },
      ]);
    });

    test("lists a linked child's Google Play subscription on the parent's profile", async () => {
      const school = await createSchool(db.sql);
      const parent = await createUser(db.sql, school.id);
      await assignRole(db.sql, school.id, parent.id, "PARENT");
      const child = await createStudent(db.sql, school.id);
      const otherChild = await createStudent(db.sql, school.id);
      await linkParent(school.id, parent.id, child.id);
      await aiAddon(school.id, child.id, { store: "google" });
      // Not linked to this parent: never shown.
      await aiAddon(school.id, otherChild.id, { store: "apple" });

      const profile = await resolveProfile(school.id, parent.id);

      expect(profile?.active_store_subscriptions).toEqual([
        { platform: "google_play", for_child: true },
      ]);
    });

    test("ignores Stripe-billed and ended subscriptions", async () => {
      const school = await createSchool(db.sql);
      const stripeStudent = await createStudent(db.sql, school.id);
      await assignRole(db.sql, school.id, stripeStudent.userId, "STUDENT");
      await aiAddon(school.id, stripeStudent.id, { stripe: `sub_${crypto.randomUUID()}` });
      const endedStudent = await createStudent(db.sql, school.id);
      await assignRole(db.sql, school.id, endedStudent.userId, "STUDENT");
      await aiAddon(school.id, endedStudent.id, { store: "apple", ended: true });

      expect(
        (await resolveProfile(school.id, stripeStudent.userId))?.active_store_subscriptions,
      ).toEqual([]);
      expect(
        (await resolveProfile(school.id, endedStudent.userId))?.active_store_subscriptions,
      ).toEqual([]);
    });
  });
});
