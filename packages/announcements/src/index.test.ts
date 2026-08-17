/**
 * Announcement audience resolution and publishing (ST-194), against a real database.
 *
 * The audience-targeting acceptance criterion ("reaches only intended audience") and the
 * mandatory-vs-optional delivery split are already proven end to end — HTTP request through real
 * RLS through real `app.notifications` writes — by `apps/api/tests/announcements/announcements-http.test.ts`,
 * including the "class" audience shape (whose fixture needs a course/term/teacher/room this thinner
 * package-level test deliberately does not rebuild). What that HTTP suite does not exercise is this
 * module's own claim guard in isolation: calling `publishAnnouncement` a second time against an
 * already-published row. That is the one behavior worth a dedicated test at this layer, alongside
 * the "school" and "role" audience shapes, which only need a school and some users.
 *
 * Skipped (as `skipIf` tests) unless `TEST_DATABASE_URL` is set, matching every other
 * integration suite in this monorepo (see `apps/workers/src/queues/reports/report-expiry-sweep.test.ts`
 * for the seed/cleanup pattern this mirrors).
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  getAnnouncementReach,
  publishAnnouncement,
  resolveAnnouncementRecipientIds,
} from "./index";

import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dbTest = test.skipIf(!enabled);

let db: Sql | undefined;

/** Schools seeded by this file, so afterAll can remove them and the DB is left as found. */
const seededSchools: string[] = [];

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  if (db) {
    await removeSeededSchools();
    await db.end({ timeout: 5 });
  }
});

async function removeSeededSchools(): Promise<void> {
  for (const schoolId of seededSchools) {
    try {
      await db!.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`DELETE FROM app.announcement_recipients WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.announcements WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.notifications WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.user_roles WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.users WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.schools WHERE id = ${schoolId}::uuid`;
      });
    } catch {
      // Best-effort: a school left behind by a crashed run doesn't fail the suite.
    }
  }
}

interface Fixture {
  schoolId: string;
  activeInstructorId: string;
  activeStudentId: string;
  suspendedUserId: string;
}

/** One school, one active INSTRUCTOR, one active STUDENT, and one suspended user with no role —
 * enough to distinguish "school" (active users only) from "role" (one role only) and to prove a
 * suspended account is excluded from either. */
async function seedFixture(): Promise<Fixture> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;

    const slug = `announcements-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Announcements Test School ${slug}`}, ${`${slug}@admin.local`},
        ${`${slug}@admin.local`}, ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;
    seededSchools.push(schoolId);

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const insertUser = async (emailPrefix: string, status: "active" | "suspended") => {
      const email = `${emailPrefix}-${slug}@test.local`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, status)
        VALUES (${schoolId}::uuid, ${email}, ${email}, ${status})
        RETURNING id
      `;
      return user!.id;
    };

    const activeInstructorId = await insertUser("instructor", "active");
    const activeStudentId = await insertUser("student", "active");
    const suspendedUserId = await insertUser("suspended", "suspended");

    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (${schoolId}::uuid, ${activeInstructorId}::uuid, 'INSTRUCTOR'::app.user_role)
    `;

    return { schoolId, activeInstructorId, activeStudentId, suspendedUserId };
  });
}

async function insertScheduledAnnouncement(
  tx: TransactionSql,
  schoolId: string,
  createdBy: string,
  scheduledAt: Date,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.announcements
      (school_id, created_by, title, body, mandatory, audience_type, status, scheduled_at)
    VALUES (
      ${schoolId}::uuid, ${createdBy}::uuid, 'Test announcement', 'Body.', true, 'school',
      'scheduled', ${scheduledAt}::timestamptz
    )
    RETURNING id
  `;
  return row!.id;
}

describe("resolveAnnouncementRecipientIds", () => {
  dbTest("'school' resolves every active user, excluding suspended ones", async () => {
    const fixture = await seedFixture();

    const ids = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      return resolveAnnouncementRecipientIds(tx, fixture.schoolId, {
        audienceType: "school",
        audienceRole: null,
        audienceClassId: null,
      });
    });

    expect(ids.sort()).toEqual([fixture.activeInstructorId, fixture.activeStudentId].sort());
  });

  dbTest("'role' resolves only active users holding that role", async () => {
    const fixture = await seedFixture();

    const ids = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      return resolveAnnouncementRecipientIds(tx, fixture.schoolId, {
        audienceType: "role",
        audienceRole: "INSTRUCTOR",
        audienceClassId: null,
      });
    });

    expect(ids).toEqual([fixture.activeInstructorId]);
  });
});

describe("publishAnnouncement", () => {
  dbTest("claims a due row exactly once; a second call is a no-op", async () => {
    const fixture = await seedFixture();
    const now = new Date();

    const announcementId = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      return insertScheduledAnnouncement(tx, fixture.schoolId, fixture.activeInstructorId, now);
    });

    // Captured after the insert, not reused from `now` above: `ck_announcements_timestamps`
    // requires `updated_at >= created_at`, and `created_at` is the database's own clock at insert
    // time, not the JS `Date` captured before the round trip.
    const publishedAt = new Date();

    const first = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      return publishAnnouncement(tx, fixture.schoolId, announcementId, publishedAt);
    });
    expect(first).toEqual({ published: true, recipientCount: 2, notifiedCount: 2 });

    const second = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      return publishAnnouncement(tx, fixture.schoolId, announcementId, publishedAt);
    });
    expect(second).toEqual({ published: false, recipientCount: 0, notifiedCount: 0 });

    const reach = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      return getAnnouncementReach(tx, fixture.schoolId, announcementId);
    });
    expect(reach).toEqual({ recipientCount: 2, notifiedCount: 2 });
  });
});
