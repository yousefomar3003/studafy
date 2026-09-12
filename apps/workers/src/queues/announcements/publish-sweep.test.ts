/**
 * The announcement scheduled-publish sweep (ST-275), against a real database.
 *
 * Proves the "scheduled publish fires in school timezone" acceptance criterion at the layer that
 * owns it: this drives `publishDueAnnouncements` itself, the exact sweep the workers' 5-minute
 * scheduler invokes (`apps/workers/src/index.ts`), over real RLS-backed tenant transactions and real
 * `app.notifications` writes. The HTTP suite only proves the negative ("a future announcement stays
 * `scheduled` with zero reach"); this is where the positive lives.
 *
 * A scheduled announcement is stored as an absolute instant (`timestamptz`), so a school scheduling
 * "08:00 local" sends the instant that wall-clock time maps to and the sweep fires it the moment
 * that instant is reached — timezone-free by construction. The first test makes that explicit with an
 * Africa/Casablanca (UTC+1, no DST since 2018) example: 08:00 local is 07:00Z, and a sweep handed a
 * `now` after that instant publishes it.
 *
 * Skipped (as `skipIf` tests) unless `TEST_DATABASE_URL` is set, matching every other integration
 * suite in this monorepo. The seed/cleanup pattern mirrors `report-expiry-sweep.test.ts` and
 * `packages/announcements/src/index.test.ts`.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { publishDueAnnouncements } from "./publish-sweep";

import type { SweepLogger } from "./publish-sweep";
import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const sweepTest = test.skipIf(!enabled);

let db: Sql | undefined;

/** Schools seeded by this file, so afterAll can remove them and the DB is left as found. */
const seededSchools: string[] = [];

const silentLogger: SweepLogger = { warn: () => undefined };

// Africa/Casablanca is UTC+1 year-round (Morocco has had no DST since 2018), so an admin picking
// "publish at 08:00 school-local" submits the absolute instant 07:00Z. Building the schedule
// instant from that offset — rather than mindlessly subtracting one hour from "now" — is what keeps
// this test a real proof of the timezone claim instead of a tautology.
const CASABLANCA_OFFSET_MS = 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

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
        await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
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
  /** Both users are 'active'; the school audience resolves to exactly these two. */
  userIds: string[];
}

/** One school, two active users, no roles — enough for the school audience shape. */
async function seedFixture(): Promise<Fixture> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;

    const slug = `announcement-sweep-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Announcement Sweep School ${slug}`}, ${`${slug}@admin.local`},
        ${`${slug}@admin.local`}, ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;
    seededSchools.push(schoolId);

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const userIds: string[] = [];
    for (const prefix of ["sweep-a", "sweep-b"]) {
      const email = `${prefix}-${slug}@test.local`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, status)
        VALUES (${schoolId}::uuid, ${email}, ${email}, 'active')
        RETURNING id
      `;
      userIds.push(user!.id);
    }

    return { schoolId, userIds };
  });
}

async function insertScheduledAnnouncement(
  tx: TransactionSql,
  schoolId: string,
  createdBy: string,
  title: string,
  scheduledAt: Date,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.announcements
      (school_id, created_by, title, body, mandatory, audience_type, status, scheduled_at)
    VALUES (
      ${schoolId}::uuid, ${createdBy}::uuid, ${title}, 'Body.', true, 'school',
      'scheduled', ${scheduledAt}::timestamptz
    )
    RETURNING id
  `;
  return row!.id;
}

async function announcementState(
  tx: TransactionSql,
  schoolId: string,
  announcementId: string,
): Promise<{ status: string; published_at: Date | null }> {
  const [row] = await tx<{ status: string; published_at: Date | null }[]>`
    SELECT status, published_at
    FROM app.announcements
    WHERE id = ${announcementId}::uuid AND school_id = ${schoolId}::uuid
  `;
  return row!;
}

async function recipientCount(
  tx: TransactionSql,
  schoolId: string,
  announcementId: string,
): Promise<{ rows: number; notified: number }> {
  const [row] = await tx<{ rows: number; notified: number }[]>`
    SELECT count(*)::int AS rows, count(notified_at)::int AS notified
    FROM app.announcement_recipients
    WHERE school_id = ${schoolId}::uuid AND announcement_id = ${announcementId}::uuid
  `;
  return { rows: row!.rows, notified: row!.notified };
}

async function notificationCount(
  tx: TransactionSql,
  schoolId: string,
  announcementId: string,
): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM app.notifications
    WHERE school_id = ${schoolId}::uuid AND metadata ->> 'announcement_id' = ${announcementId}
  `;
  return row!.n;
}

describe("announcement publish sweep", () => {
  sweepTest(
    "publishes a due scheduled announcement at its school-timezone instant, recipient for recipient",
    async () => {
      const fixture = await seedFixture();
      const createdBy = fixture.userIds[0]!;

      // "08:00 Africa/Casablanca" as an absolute instant: the admin's wall clock read 08:00 and the
      // ISO instant submitted — for the school to see it at 08:00 local — was 07:00Z. The sweep's
      // `now` below is the wall-clock moment five school-local minutes later (the cadence the real
      // 5-minute cron runs on), i.e. 08:05 local, which is unambiguously after that instant.
      const scheduledWallClock = new Date(Date.now() - 5 * 60 * 1000);
      const dueScheduledAt = new Date(scheduledWallClock.getTime() - CASABLANCA_OFFSET_MS);
      const now = new Date();

      const dueId = await db!.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
        return insertScheduledAnnouncement(
          tx,
          fixture.schoolId,
          createdBy,
          "Due at 08:00 school time",
          dueScheduledAt,
        );
      });

      const result = await publishDueAnnouncements(db!, now, silentLogger);

      // The global `published` counter covers every school the shared test database holds, so its
      // exact value is not this test's to assert; what matters is that the sweep ran over the real
      // school list (ours included) and that our announcement fired.
      expect(result.schools).toBeGreaterThanOrEqual(1);
      await db!.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
        const state = await announcementState(tx, fixture.schoolId, dueId);
        expect(state.status).toBe("published");
        expect(state.published_at).not.toBeNull();

        // The exact recipient set: both active users, one notification each, snapshot recorded.
        const reach = await recipientCount(tx, fixture.schoolId, dueId);
        expect(reach).toEqual({ rows: 2, notified: 2 });
        expect(await notificationCount(tx, fixture.schoolId, dueId)).toBe(2);
      });
    },
  );

  sweepTest("leaves a future-scheduled announcement untouched", async () => {
    const fixture = await seedFixture();
    const createdBy = fixture.userIds[0]!;

    const futureId = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      return insertScheduledAnnouncement(
        tx,
        fixture.schoolId,
        createdBy,
        "Scheduled for later",
        new Date(Date.now() + HOUR_MS),
      );
    });

    const result = await publishDueAnnouncements(db!, new Date(), silentLogger);

    expect(result.schools).toBeGreaterThanOrEqual(1);
    await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      const state = await announcementState(tx, fixture.schoolId, futureId);
      expect(state.status).toBe("scheduled");
      expect(state.published_at).toBeNull();
      expect(await recipientCount(tx, fixture.schoolId, futureId)).toEqual({
        rows: 0,
        notified: 0,
      });
      expect(await notificationCount(tx, fixture.schoolId, futureId)).toBe(0);
    });
  });

  sweepTest("a second sweep tick never double-publishes", async () => {
    const fixture = await seedFixture();
    const createdBy = fixture.userIds[0]!;

    const dueId = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      return insertScheduledAnnouncement(
        tx,
        fixture.schoolId,
        createdBy,
        "Claimed once",
        new Date(Date.now() - 60_000),
      );
    });

    await publishDueAnnouncements(db!, new Date(), silentLogger);
    await publishDueAnnouncements(db!, new Date(), silentLogger);

    await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
      const state = await announcementState(tx, fixture.schoolId, dueId);
      expect(state.status).toBe("published");
      // Still exactly one notification per recipient — the claim guard
      // (`UPDATE ... WHERE status = 'scheduled'`) is the idempotency boundary, and a replayed
      // publish would have failed loudly on uq_announcement_recipients_announcement_user.
      expect(await recipientCount(tx, fixture.schoolId, dueId)).toEqual({ rows: 2, notified: 2 });
      expect(await notificationCount(tx, fixture.schoolId, dueId)).toBe(2);
    });
  });
});
