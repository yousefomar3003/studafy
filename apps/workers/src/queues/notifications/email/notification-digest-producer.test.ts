/**
 * Daily notification digest producer.
 *
 * Every guarantee here is a database object (the claim is a join, the grouping is a GROUP BY, the
 * per-user timezone is a Postgres AT TIME ZONE conversion), so this follows the
 * packages/db/tests / dispatcher.test.ts convention: skip unless TEST_DATABASE_URL is set, run
 * against a disposable database that has had the real migrations applied, assert on rows.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { processNotificationDigest } from "./notification-digest-producer";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let sql: Sql;

beforeAll(() => {
  if (!databaseUrl) return;
  sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, prepare: false });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

interface Fixture {
  schoolId: string;
  /** Opted into digest for COURSE_PUBLISHED and DISCUSSION_REPLY; gets one 2-item digest. */
  optedInUserId: string;
  /** Has a COURSE_PUBLISHED notification but never turned digest on for it; gets no digest. */
  notOptedInUserId: string;
  /**
   * Opted into digest for ATTENDANCE_ALERT, which already has its own dedicated parent digest
   * pipeline (digest-producer.ts) — this job must never touch it.
   */
  attendanceUserId: string;
  /** A custom timezone far from UTC, so the digest's date label can be checked against it. */
  timezoneUserId: string;
  timezoneUserTz: string;
  optedInNotificationIds: string[];
  notOptedInNotificationId: string;
  attendanceNotificationId: string;
  timezoneNotificationId: string;
}

let fixtureSeq = 0;

/**
 * A school with four users covering the acceptance criteria: correct per-user grouping, an
 * opted-out user producing no digest, ATTENDANCE_ALERT staying untouched, and a user with a
 * non-UTC timezone.
 *
 * Seeded as studafy_admin — app.notifications and app.notification_preferences carry RESTRICTIVE
 * policies Postgres applies to INSERT ... RETURNING as well as SELECT.
 */
async function seedFixture(): Promise<Fixture> {
  fixtureSeq += 1;
  const tag = `ndig${String(fixtureSeq)}-${Date.now().toString(36)}`;

  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const schoolEmail = `${tag}@admin.local`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`Digest ${tag}`}, ${schoolEmail}, ${schoolEmail},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const makeUser = async (prefix: string): Promise<string> => {
      const email = `${prefix}-${tag}@t.local`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${email}, ${email}, ${`User ${prefix}`}, 'active')
        RETURNING id
      `;
      return user!.id;
    };

    const setDigest = async (userId: string, notificationType: string): Promise<void> => {
      await tx`
        UPDATE app.notification_preferences
        SET digest = true, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ${userId}::uuid
          AND notification_type = ${notificationType}::app.notification_type
          AND channel = 'email'
      `;
    };

    const insertNotification = async (
      userId: string,
      notificationType: string,
      title: string,
    ): Promise<string> => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.notifications (school_id, user_id, notification_type, title, body)
        VALUES (
          ${schoolId}::uuid, ${userId}::uuid, ${notificationType}::app.notification_type,
          ${title}, ${`Body for ${title}`}
        )
        RETURNING id
      `;
      return row!.id;
    };

    // Opted-in user: two eligible types, digest on for both -> one digest, two items.
    const optedInUserId = await makeUser("in");
    await setDigest(optedInUserId, "COURSE_PUBLISHED");
    await setDigest(optedInUserId, "DISCUSSION_REPLY");
    const coursePublishedId = await insertNotification(
      optedInUserId,
      "COURSE_PUBLISHED",
      "New course published",
    );
    const discussionReplyId = await insertNotification(
      optedInUserId,
      "DISCUSSION_REPLY",
      "New reply in your discussion",
    );
    // GRADE_POSTED is not digest_eligible and cannot be set to digest = true (000083's
    // ck_notification_preferences_digest_eligible) — its own row is left at the seeded default and
    // must never be claimed by this job regardless.
    await insertNotification(optedInUserId, "GRADE_POSTED", "Your grade was posted");

    // Not-opted-in user: same notification type, digest left at its seeded default (false) ->
    // must produce no digest at all. This is the "empty digest skipped" case: the row exists and
    // is eligible, but nobody has opted in, so there is nothing to send.
    const notOptedInUserId = await makeUser("out");
    const notOptedInNotificationId = await insertNotification(
      notOptedInUserId,
      "COURSE_PUBLISHED",
      "New course published",
    );

    // ATTENDANCE_ALERT user: digest_eligible and opted in, but this job must never touch it — that
    // type has its own dedicated parent digest (digest-producer.ts).
    const attendanceUserId = await makeUser("att");
    await setDigest(attendanceUserId, "ATTENDANCE_ALERT");
    const attendanceNotificationId = await insertNotification(
      attendanceUserId,
      "ATTENDANCE_ALERT",
      "Attendance alert",
    );

    // Timezone user: a custom, far-from-UTC timezone, so the digest's date label can be checked
    // against an independent computation of "what day is it right now, in that timezone".
    const timezoneUserId = await makeUser("tz");
    const timezoneUserTz = "Pacific/Kiritimati"; // UTC+14 — the furthest-ahead IANA zone that exists.
    await tx`
      INSERT INTO app.user_notification_settings (user_id, school_id, timezone)
      VALUES (${timezoneUserId}::uuid, ${schoolId}::uuid, ${timezoneUserTz})
    `;
    await setDigest(timezoneUserId, "STUDY_GROUP_INVITE");
    const timezoneNotificationId = await insertNotification(
      timezoneUserId,
      "STUDY_GROUP_INVITE",
      "You were invited to a study group",
    );

    return {
      schoolId,
      optedInUserId,
      notOptedInUserId,
      attendanceUserId,
      timezoneUserId,
      timezoneUserTz,
      optedInNotificationIds: [coursePublishedId, discussionReplyId],
      notOptedInNotificationId,
      attendanceNotificationId,
      timezoneNotificationId,
    };
  });
}

async function digestRowsFor(
  schoolId: string,
  userId: string,
): Promise<{ id: string; payload: Record<string, unknown> }[]> {
  return await sql<{ id: string; payload: Record<string, unknown> }[]>`
    SELECT id, payload
    FROM app.outbox_events
    WHERE school_id = ${schoolId}::uuid
      AND event_name = 'notification.digestSent'
      AND payload->>'userId' = ${userId}
  `;
}

async function digestedAt(notificationId: string): Promise<string | null> {
  const [row] = await sql<{ digested_at: string | null }[]>`
    SELECT digested_at FROM app.notifications WHERE id = ${notificationId}::uuid
  `;
  return row!.digested_at;
}

describeDb("processNotificationDigest", () => {
  test("groups an opted-in recipient's eligible notifications into one digest", async () => {
    const fixture = await seedFixture();
    const result = await processNotificationDigest(databaseUrl!);
    expect(result.processed).toBe(true);

    const rows = await digestRowsFor(fixture.schoolId, fixture.optedInUserId);
    expect(rows).toHaveLength(1);

    const items = rows[0]!.payload.items as { notificationType: string; title: string }[];
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.notificationType))).toEqual(
      new Set(["COURSE_PUBLISHED", "DISCUSSION_REPLY"]),
    );

    for (const id of fixture.optedInNotificationIds) {
      expect(await digestedAt(id)).not.toBeNull();
    }
  });

  test("skips a recipient who has not opted into digest — no digest is sent", async () => {
    const fixture = await seedFixture();
    await processNotificationDigest(databaseUrl!);

    const rows = await digestRowsFor(fixture.schoolId, fixture.notOptedInUserId);
    expect(rows).toHaveLength(0);
    // The row stays claimable rather than silently dropped: it just was never a match.
    expect(await digestedAt(fixture.notOptedInNotificationId)).toBeNull();
  });

  test("never digests ATTENDANCE_ALERT — it has its own dedicated pipeline", async () => {
    const fixture = await seedFixture();
    await processNotificationDigest(databaseUrl!);

    const rows = await digestRowsFor(fixture.schoolId, fixture.attendanceUserId);
    expect(rows).toHaveLength(0);
    expect(await digestedAt(fixture.attendanceNotificationId)).toBeNull();
  });

  test("labels the digest with the recipient's own local calendar date", async () => {
    const fixture = await seedFixture();
    await processNotificationDigest(databaseUrl!);

    const [expected] = await sql<{ today: string }[]>`
      SELECT (CURRENT_TIMESTAMP AT TIME ZONE ${fixture.timezoneUserTz})::date::text AS today
    `;

    const rows = await digestRowsFor(fixture.schoolId, fixture.timezoneUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.digestDate).toBe(expected!.today);
  });

  test("running twice does not re-digest an already-digested notification", async () => {
    const fixture = await seedFixture();
    await processNotificationDigest(databaseUrl!);
    const second = await processNotificationDigest(databaseUrl!);

    // Nothing left to claim for this school on the second pass.
    expect(second.notificationsClaimed).toBe(0);

    const rows = await digestRowsFor(fixture.schoolId, fixture.optedInUserId);
    expect(rows).toHaveLength(1);
  });
});
