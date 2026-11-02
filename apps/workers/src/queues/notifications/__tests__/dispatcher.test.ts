/**
 * Notification dispatcher (ST-139).
 *
 * The pure helpers are unit-tested here and always run. Everything that proves an actual acceptance
 * criterion needs a real database, because every one of those guarantees *is* a database object —
 * the fan-out is a join, and the idempotency is a unique index. Those follow the packages/db/tests
 * convention this app already uses in attendance-alert.test.ts: skip unless TEST_DATABASE_URL is
 * set, run against a disposable database that has had the real migrations applied, assert on rows.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { handleDeadLetter } from "../dead-letter";
import { buildIdempotencyKey, processNotificationDispatch } from "../dispatcher.worker";
import { formatGrade } from "../resolvers/recipient.resolver";

import type { DeliverNotificationJobData } from "../dispatcher.worker";
import type { Sql } from "postgres";

// ---------------------------------------------------------------------------
// Pure — no database
// ---------------------------------------------------------------------------

describe("buildIdempotencyKey", () => {
  test("carries event type, event id, recipient and channel", () => {
    expect(buildIdempotencyKey("grades.published", "sub-1", "user-1", "email")).toBe(
      "grades.published:sub-1:user-1:email",
    );
  });

  test("the channel is part of the key", () => {
    // Without it, a recipient's email reservation would swallow their push reservation and one of
    // the two would never be sent — the trap 000056 documents for parent_user_id.
    const email = buildIdempotencyKey("grades.published", "sub-1", "user-1", "email");
    const push = buildIdempotencyKey("grades.published", "sub-1", "user-1", "push");
    expect(email).not.toBe(push);
  });

  test("two recipients of one event get different keys", () => {
    const student = buildIdempotencyKey("grades.published", "sub-1", "user-1", "email");
    const parent = buildIdempotencyKey("grades.published", "sub-1", "user-2", "email");
    expect(student).not.toBe(parent);
  });
});

describe("formatGrade", () => {
  test("renders score over max", () => {
    expect(formatGrade("85.00", "100.00")).toBe("85/100");
  });

  test("keeps a meaningful decimal", () => {
    expect(formatGrade("85.50", "100.00")).toBe("85.5/100");
  });

  test("says so when there is nothing to show", () => {
    expect(formatGrade(null, "100.00")).toBe("not graded");
    expect(formatGrade("85.00", null)).toBe("not graded");
  });
});

// ---------------------------------------------------------------------------
// Integration — real Postgres
// ---------------------------------------------------------------------------

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
  studentId: string;
  studentUserId: string;
  parentIds: string[];
  /** A parent of a different student in the same school. Must never be notified. */
  unrelatedParentId: string;
  /** A classmate enrolled in the same class. Must never be notified. */
  classmateUserId: string;
  submissionId: string;
}

let fixtureSeq = 0;

/**
 * A school with one graded student, `parentCount` linked parents, one classmate, and one parent of
 * that classmate.
 *
 * The classmate and the unrelated parent are the negative controls: the fan-out criterion is
 * "exactly the affected students and their linked parents", and a test that seeds only the people
 * who *should* be notified cannot tell a correct query from `SELECT * FROM app.users`.
 *
 * Seeded as studafy_admin — several of these tables carry RESTRICTIVE policies that PostgreSQL
 * applies to INSERT ... RETURNING as well as SELECT.
 */
async function seedFixture(
  options: { parentCount?: number; publish?: boolean } = {},
): Promise<Fixture> {
  const parentCount = options.parentCount ?? 2;
  const publish = options.publish ?? true;
  fixtureSeq += 1;
  const tag = `disp${fixtureSeq}-${Date.now().toString(36)}`;

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
      VALUES (${tag}, ${`Dispatch ${tag}`}, ${schoolEmail}, ${schoolEmail},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const makeUser = async (prefix: string, name: string): Promise<string> => {
      const email = `${prefix}-${tag}@t.local`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${email}, ${email}, ${name}, 'active')
        RETURNING id
      `;
      return user!.id;
    };

    const makeStudent = async (userId: string, prefix: string): Promise<string> => {
      const [student] = await tx<{ id: string }[]>`
        INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
        VALUES (${schoolId}::uuid, ${userId}::uuid, ${`ADM-${prefix}-${tag}`},
                'Amina', 'Tazi', 'enrolled')
        RETURNING id
      `;
      return student!.id;
    };

    const linkParent = async (
      parentUserId: string,
      studentId: string,
      index: number,
    ): Promise<void> => {
      const [family] = await tx<{ id: string }[]>`
        INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
        VALUES (${schoolId}::uuid, ${`Family ${index}-${tag}`}, ${parentUserId}::uuid)
        RETURNING id
      `;
      await tx`
        INSERT INTO app.parent_child_links
          (school_id, family_id, parent_user_id, student_id, relationship)
        VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${parentUserId}::uuid,
                ${studentId}::uuid, 'guardian')
      `;
    };

    const studentUserId = await makeUser("s", "Student");
    const studentId = await makeStudent(studentUserId, "s");

    const parentIds: string[] = [];
    for (let i = 0; i < parentCount; i += 1) {
      const parentId = await makeUser(`p${String(i)}`, "Parent");
      await linkParent(parentId, studentId, i);
      parentIds.push(parentId);
    }

    // Negative controls: a classmate in the same class, and that classmate's parent.
    const classmateUserId = await makeUser("cm", "Classmate");
    const classmateStudentId = await makeStudent(classmateUserId, "cm");
    const unrelatedParentId = await makeUser("up", "Unrelated Parent");
    await linkParent(unrelatedParentId, classmateStudentId, 99);

    // Academic scaffolding. Column lists mirror apps/api/tests/harness/factories.ts.
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${`Y-${tag}`}, ${`Year ${tag}`}, '2026-06-01', '2027-05-31', 'active')
      RETURNING id
    `;
    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${year!.id}::uuid, ${`T-${tag}`}, ${`Term ${tag}`}, 1::smallint,
              '2026-06-01', '2026-12-31', 'active')
      RETURNING id
    `;
    const [subject] = await tx<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${schoolId}::uuid, ${`S-${tag}`}, ${`Subject ${tag}`}, 'active') RETURNING id
    `;
    const [course] = await tx<{ id: string }[]>`
      INSERT INTO app.courses (school_id, subject_id, code, name, status)
      VALUES (${schoolId}::uuid, ${subject!.id}::uuid, ${`C-${tag}`}, 'Biology 101', 'active')
      RETURNING id
    `;
    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${schoolId}::uuid, ${`R-${tag}`}, ${`Room ${tag}`}, 'physical', 30, 'Main Building')
      RETURNING id
    `;
    const teacherUserId = await makeUser("t", "Teacher");
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${schoolId}::uuid, ${teacherUserId}::uuid, ${`E-${tag}`}, 'active')
      RETURNING id
    `;
    const [cls] = await tx<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity, status)
      VALUES (${schoolId}::uuid, ${course!.id}::uuid, ${year!.id}::uuid, ${term!.id}::uuid,
              ${teacher!.id}::uuid, ${room!.id}::uuid, ${`CLS-${tag}`}, 30, 'active')
      RETURNING id
    `;
    for (const enrolled of [studentId, classmateStudentId]) {
      await tx`
        INSERT INTO app.enrollments (school_id, class_id, student_id)
        VALUES (${schoolId}::uuid, ${cls!.id}::uuid, ${enrolled}::uuid)
      `;
    }

    const [gradebook] = await tx<{ id: string }[]>`
      INSERT INTO app.gradebooks (school_id, class_id, status)
      VALUES (${schoolId}::uuid, ${cls!.id}::uuid, 'active')
      RETURNING id
    `;
    // Walked through the real lifecycle rather than inserted at its end.
    // app.enforce_grade_submission_transition rejects any INSERT whose status is not `draft`, and
    // sets submitted_at/decided_at itself on each transition — so the timestamps cannot be seeded
    // and the path draft → submitted → approved → published has to be taken one step at a time.
    const [submission] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id, status)
      VALUES (${schoolId}::uuid, ${gradebook!.id}::uuid, ${studentId}::uuid, 'draft')
      RETURNING id
    `;
    const submissionId = submission!.id;

    await tx`
      INSERT INTO app.grades (school_id, grade_submission_id, score, max_score, weight, label)
      VALUES (${schoolId}::uuid, ${submissionId}::uuid, 85.00, 100.00, 1, 'Lab Report 3')
    `;

    await tx`
      UPDATE app.grade_submissions
      SET status = 'submitted'::app.grade_submission_status,
          submitted_by_user_id = ${teacherUserId}::uuid,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${submissionId}::uuid AND school_id = ${schoolId}::uuid
    `;

    if (publish) {
      await tx`
        UPDATE app.grade_submissions
        SET status = 'approved'::app.grade_submission_status,
            decided_by_user_id = ${teacherUserId}::uuid,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${submissionId}::uuid AND school_id = ${schoolId}::uuid
      `;
      await tx`
        UPDATE app.grade_submissions
        SET status = 'published'::app.grade_submission_status,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${submissionId}::uuid AND school_id = ${schoolId}::uuid
      `;
    }

    return {
      schoolId,
      studentId,
      studentUserId,
      parentIds,
      unrelatedParentId,
      classmateUserId,
      submissionId,
    };
  });
}

/** Collects delivery enqueues instead of touching Redis. */
function collectingEnqueuer(): {
  enqueueDelivery: (data: DeliverNotificationJobData) => Promise<void>;
  enqueued: DeliverNotificationJobData[];
} {
  const enqueued: DeliverNotificationJobData[] = [];
  return {
    enqueued,
    enqueueDelivery: async (data) => {
      enqueued.push(data);
    },
  };
}

function dispatchJob(fixture: Fixture) {
  return {
    schoolId: fixture.schoolId,
    eventId: fixture.submissionId,
    eventType: "grades.published",
    submissionId: fixture.submissionId,
  };
}

async function notificationRecipients(schoolId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id FROM app.notifications
    WHERE school_id = ${schoolId}::uuid AND notification_type = 'GRADE_POSTED'
    ORDER BY user_id
  `;
  return rows.map((row) => row.user_id);
}

async function dispatchLogStatuses(schoolId: string): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; count: number }[]>`
    SELECT status::text AS status, count(*)::int AS count
    FROM app.notification_dispatch_logs
    WHERE school_id = ${schoolId}::uuid
    GROUP BY status
  `;
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

async function asAdmin<T>(schoolId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    return fn(tx);
  });
}

describeDb("processNotificationDispatch — fan-out", () => {
  test("reaches exactly the graded student and their linked parents", async () => {
    const fixture = await seedFixture({ parentCount: 2 });
    const { enqueueDelivery } = collectingEnqueuer();

    const result = await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    expect(result.recipientsResolved).toBe(3);

    const notified = await notificationRecipients(fixture.schoolId);
    expect(notified).toEqual([fixture.studentUserId, ...fixture.parentIds].sort());

    // The negative controls: a classmate in the same class and a parent of that classmate.
    expect(notified).not.toContain(fixture.classmateUserId);
    expect(notified).not.toContain(fixture.unrelatedParentId);
  });

  test("a student with no linked parents notifies only the student", async () => {
    const fixture = await seedFixture({ parentCount: 0 });
    const { enqueueDelivery } = collectingEnqueuer();

    const result = await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    expect(result.recipientsResolved).toBe(1);
    expect(await notificationRecipients(fixture.schoolId)).toEqual([fixture.studentUserId]);
  });

  test("an unpublished submission dispatches nothing and does not throw", async () => {
    // Stale rather than broken: returning cleanly keeps it out of the dead-letter table, which is
    // for things somebody has to act on.
    const fixture = await seedFixture({ publish: false });
    const { enqueueDelivery, enqueued } = collectingEnqueuer();

    const result = await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    expect(result.recipientsResolved).toBe(0);
    expect(result.dispatched).toBe(0);
    expect(enqueued).toEqual([]);
    expect(await notificationRecipients(fixture.schoolId)).toEqual([]);
  });

  test("renders the event context into the notification body", async () => {
    const fixture = await seedFixture({ parentCount: 1 });
    const { enqueueDelivery, enqueued } = collectingEnqueuer();

    await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    const [row] = await sql<{ title: string; body: string }[]>`
      SELECT title, body FROM app.notifications
      WHERE school_id = ${fixture.schoolId}::uuid AND user_id = ${fixture.studentUserId}::uuid
    `;
    // The in_app template is the short one — assessment and grade, no course name.
    expect(row!.title).toContain("Lab Report 3");
    expect(row!.body).toContain("Lab Report 3");
    expect(row!.body).toContain("85/100");

    // The email template is the long one, and it is where the resolved course name shows up. That
    // it does proves the resolver joined gradebook → class → course rather than the event payload.
    const email = enqueued.find((job) => job.channel === "email");
    expect(email?.body).toContain("Biology 101");
    expect(email?.body).toContain("85/100");
  });

  test("renders Arabic when the recipient's locale says so", async () => {
    const fixture = await seedFixture({ parentCount: 1 });
    await asAdmin(fixture.schoolId, async (tx) => {
      await tx`
        INSERT INTO app.user_notification_settings (school_id, user_id, locale)
        VALUES (${fixture.schoolId}::uuid, ${fixture.parentIds[0]!}::uuid, 'ar')
      `;
    });
    const { enqueueDelivery } = collectingEnqueuer();

    await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    const [parent] = await sql<{ body: string }[]>`
      SELECT body FROM app.notifications
      WHERE school_id = ${fixture.schoolId}::uuid AND user_id = ${fixture.parentIds[0]!}::uuid
    `;
    const [student] = await sql<{ body: string }[]>`
      SELECT body FROM app.notifications
      WHERE school_id = ${fixture.schoolId}::uuid AND user_id = ${fixture.studentUserId}::uuid
    `;
    expect(/[؀-ۿ]/.test(parent!.body)).toBe(true);
    // The student kept the school default, so one locale override does not move everyone.
    expect(/[؀-ۿ]/.test(student!.body)).toBe(false);
  });
});

describeDb("processNotificationDispatch — idempotency", () => {
  test("re-running the same job notifies nobody a second time", async () => {
    const fixture = await seedFixture({ parentCount: 2 });
    const { enqueueDelivery } = collectingEnqueuer();
    const deps = { databaseUrl: databaseUrl!, enqueueDelivery };

    const first = await processNotificationDispatch(dispatchJob(fixture), deps);
    const second = await processNotificationDispatch(dispatchJob(fixture), deps);

    expect(first.dispatched).toBeGreaterThan(0);
    expect(first.duplicatesSkipped).toBe(0);

    // Every channel of every recipient is now confirmed, so the replay claims nothing.
    expect(second.dispatched).toBe(0);
    expect(second.duplicatesSkipped).toBe(first.dispatched);

    // Three recipients, one in_app row each — not six.
    expect(await notificationRecipients(fixture.schoolId)).toHaveLength(3);
  });

  test("a confirmed reservation is never reclaimed", async () => {
    const fixture = await seedFixture({ parentCount: 1 });
    const { enqueueDelivery } = collectingEnqueuer();
    const deps = { databaseUrl: databaseUrl!, enqueueDelivery };

    await processNotificationDispatch(dispatchJob(fixture), deps);

    // Age every reservation far past the lease. A confirmed row must still be untouchable —
    // the lease only ever applies to reservations whose outcome is unknown.
    await asAdmin(fixture.schoolId, async (tx) => {
      await tx`
        UPDATE app.notification_idempotency_keys
        SET reserved_at = CURRENT_TIMESTAMP - INTERVAL '1 day'
        WHERE school_id = ${fixture.schoolId}::uuid
      `;
    });

    const replay = await processNotificationDispatch(dispatchJob(fixture), deps);
    expect(replay.dispatched).toBe(0);
    expect(await notificationRecipients(fixture.schoolId)).toHaveLength(2);
  });

  test("an expired unconfirmed reservation is reclaimed", async () => {
    // This is the case a bare INSERT ... ON CONFLICT DO NOTHING gets wrong: a crash between the
    // reservation and the send would leave the recipient permanently skipped, and the job would
    // then report success.
    const fixture = await seedFixture({ parentCount: 0 });
    const { enqueueDelivery, enqueued } = collectingEnqueuer();
    const deps = { databaseUrl: databaseUrl!, enqueueDelivery };

    await processNotificationDispatch(dispatchJob(fixture), deps);
    const firstEnqueueCount = enqueued.length;
    expect(firstEnqueueCount).toBeGreaterThan(0);

    // Simulate a worker that reserved and then died: unconfirm the push/email rows and age them.
    await asAdmin(fixture.schoolId, async (tx) => {
      await tx`
        UPDATE app.notification_idempotency_keys
        SET dispatched_at = NULL, reserved_at = CURRENT_TIMESTAMP - INTERVAL '1 day'
        WHERE school_id = ${fixture.schoolId}::uuid
          AND channel <> 'in_app'
      `;
    });

    const recovery = await processNotificationDispatch(dispatchJob(fixture), deps);

    expect(recovery.dispatched).toBe(firstEnqueueCount);
    expect(enqueued).toHaveLength(firstEnqueueCount * 2);
    // in_app was left confirmed, so no second inbox row appeared.
    expect(await notificationRecipients(fixture.schoolId)).toHaveLength(1);
  });

  test("the idempotency key is unique per school, recipient and channel", async () => {
    const fixture = await seedFixture({ parentCount: 1 });
    const { enqueueDelivery } = collectingEnqueuer();

    await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    const rows = await sql<{ idempotency_key: string }[]>`
      SELECT idempotency_key FROM app.notification_idempotency_keys
      WHERE school_id = ${fixture.schoolId}::uuid
    `;
    const keys = rows.map((row) => row.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
    // Two recipients across three channels.
    expect(keys).toHaveLength(6);
    for (const key of keys) {
      expect(key.startsWith(`grades.published:${fixture.submissionId}:`)).toBe(true);
    }
  });
});

describeDb("processNotificationDispatch — preferences and quiet hours", () => {
  test("a disabled channel is suppressed and recorded as such", async () => {
    const fixture = await seedFixture({ parentCount: 0 });
    await asAdmin(fixture.schoolId, async (tx) => {
      await tx`
        UPDATE app.notification_preferences
        SET enabled = false
        WHERE user_id = ${fixture.studentUserId}::uuid
          AND notification_type = 'GRADE_POSTED'
          AND channel = 'email'
      `;
    });
    const { enqueueDelivery, enqueued } = collectingEnqueuer();

    const result = await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    expect(result.suppressedPreference).toBe(1);
    expect(enqueued.map((job) => job.channel)).toEqual(["push"]);

    const statuses = await dispatchLogStatuses(fixture.schoolId);
    expect(statuses.suppressed_preference).toBe(1);

    // A suppression must claim no reservation — turning the channel back on has to be able to
    // notify, and a consumed key would silently prevent that forever.
    const [reserved] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.notification_idempotency_keys
      WHERE school_id = ${fixture.schoolId}::uuid AND channel = 'email'
    `;
    expect(reserved!.count).toBe(0);
  });

  test("a recipient inside quiet hours is suppressed and gets no notification", async () => {
    const fixture = await seedFixture({ parentCount: 0 });
    // A window that certainly contains "now" in the recipient's own timezone, whatever now is.
    await asAdmin(fixture.schoolId, async (tx) => {
      await tx`
        INSERT INTO app.user_notification_settings
          (school_id, user_id, quiet_hours_start, quiet_hours_end, timezone)
        VALUES (
          ${fixture.schoolId}::uuid, ${fixture.studentUserId}::uuid,
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Amman' - INTERVAL '1 hour')::time,
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Amman' + INTERVAL '1 hour')::time,
          'Asia/Amman'
        )
      `;
    });
    const { enqueueDelivery, enqueued } = collectingEnqueuer();

    const result = await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    expect(result.suppressedQuietHours).toBe(3);
    expect(result.dispatched).toBe(0);
    expect(enqueued).toEqual([]);
    expect(await notificationRecipients(fixture.schoolId)).toEqual([]);

    const statuses = await dispatchLogStatuses(fixture.schoolId);
    expect(statuses.suppressed_quiet_hours).toBe(3);
  });

  test("a recipient outside quiet hours is unaffected", async () => {
    const fixture = await seedFixture({ parentCount: 0 });
    await asAdmin(fixture.schoolId, async (tx) => {
      await tx`
        INSERT INTO app.user_notification_settings
          (school_id, user_id, quiet_hours_start, quiet_hours_end, timezone)
        VALUES (
          ${fixture.schoolId}::uuid, ${fixture.studentUserId}::uuid,
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Amman' + INTERVAL '2 hours')::time,
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Amman' + INTERVAL '4 hours')::time,
          'Asia/Amman'
        )
      `;
    });
    const { enqueueDelivery } = collectingEnqueuer();

    const result = await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    expect(result.suppressedQuietHours).toBe(0);
    expect(await notificationRecipients(fixture.schoolId)).toEqual([fixture.studentUserId]);
  });

  test("quiet hours are evaluated in the recipient's own timezone", async () => {
    // The same wall-clock window, anchored to a zone thirteen hours away, must not match.
    const fixture = await seedFixture({ parentCount: 0 });
    await asAdmin(fixture.schoolId, async (tx) => {
      await tx`
        INSERT INTO app.user_notification_settings
          (school_id, user_id, quiet_hours_start, quiet_hours_end, timezone)
        VALUES (
          ${fixture.schoolId}::uuid, ${fixture.studentUserId}::uuid,
          (CURRENT_TIMESTAMP AT TIME ZONE 'Pacific/Auckland' - INTERVAL '1 hour')::time,
          (CURRENT_TIMESTAMP AT TIME ZONE 'Pacific/Auckland' + INTERVAL '1 hour')::time,
          'Pacific/Auckland'
        )
      `;
    });
    const { enqueueDelivery } = collectingEnqueuer();

    const result = await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    // The window was built from Auckland's clock and is read back against Auckland's clock, so it
    // matches — which is the point. Reading it against UTC would not.
    expect(result.suppressedQuietHours).toBe(3);
  });
});

describeDb("processNotificationDispatch — delivery hand-off", () => {
  test("in_app writes an inbox row; push and email are enqueued", async () => {
    const fixture = await seedFixture({ parentCount: 0 });
    const { enqueueDelivery, enqueued } = collectingEnqueuer();

    await processNotificationDispatch(dispatchJob(fixture), {
      databaseUrl: databaseUrl!,
      enqueueDelivery,
    });

    expect(enqueued.map((job) => job.channel).sort()).toEqual(["email", "push"]);
    for (const job of enqueued) {
      expect(job.schoolId).toBe(fixture.schoolId);
      expect(job.recipientId).toBe(fixture.studentUserId);
      expect(job.title).toContain("Lab Report 3");
      expect(job.body.length).toBeGreaterThan(0);
    }

    const statuses = await dispatchLogStatuses(fixture.schoolId);
    expect(statuses.delivered).toBe(1);
    expect(statuses.enqueued).toBe(2);
  });

  test("a failing enqueue leaves the reservation unconfirmed and fails the job", async () => {
    const fixture = await seedFixture({ parentCount: 0 });

    await expect(
      processNotificationDispatch(dispatchJob(fixture), {
        databaseUrl: databaseUrl!,
        enqueueDelivery: () => Promise.reject(new Error("redis is down")),
      }),
    ).rejects.toThrow(/unresolved/);

    // in_app still succeeded — one recipient's channel failing must not abandon the rest.
    expect(await notificationRecipients(fixture.schoolId)).toEqual([fixture.studentUserId]);

    const [unconfirmed] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.notification_idempotency_keys
      WHERE school_id = ${fixture.schoolId}::uuid AND dispatched_at IS NULL
    `;
    expect(unconfirmed!.count).toBe(2);
  });
});

describeDb("handleDeadLetter", () => {
  test("records the failure and raises notification.dispatchFailed", async () => {
    const fixture = await seedFixture({ parentCount: 0 });
    const logged: string[] = [];
    const log = {
      warn: (fields: Record<string, unknown>) => logged.push(String(fields.event)),
      error: (fields: Record<string, unknown>) => logged.push(String(fields.event)),
    };

    const deadLetterId = await handleDeadLetter({
      job: {
        id: "job-99",
        name: "dispatch-notification",
        data: dispatchJob(fixture),
        attemptsMade: 5,
        finishedOn: Date.now(),
        stacktrace: ["Error: boom\n    at somewhere"],
      },
      error: new Error("boom"),
      databaseUrl: databaseUrl!,
      queueName: "notifications",
      log,
    });

    expect(deadLetterId).not.toBeNull();
    expect(logged).toContain("notification_dispatch_dead_lettered");

    const [row] = await sql<
      {
        job_id: string;
        attempts_made: number;
        error_class: string;
        error_message: string;
        error_stack: string | null;
      }[]
    >`
      SELECT job_id, attempts_made, error_class, error_message, error_stack
      FROM app.notification_dead_letters
      WHERE school_id = ${fixture.schoolId}::uuid
    `;
    expect(row!.job_id).toBe("job-99");
    expect(row!.attempts_made).toBe(5);
    expect(row!.error_class).toBe("Error");
    expect(row!.error_message).toBe("boom");
    expect(row!.error_stack).toContain("boom");

    const [event] = await sql<{ event_name: string; payload: Record<string, unknown> }[]>`
      SELECT event_name, payload FROM app.outbox_events
      WHERE school_id = ${fixture.schoolId}::uuid
    `;
    expect(event!.event_name).toBe("notification.dispatchFailed");
    // A real jsonb object, not a jsonb string — the tx.json() vs stringify+::jsonb trap.
    expect(event!.payload.deadLetterId).toBe(deadLetterId);
    expect(event!.payload.attemptsMade).toBe(5);
    // Correlation handles only: no stack ever reaches the pub/sub channel.
    expect(Object.keys(event!.payload)).not.toContain("errorStack");
    expect(Object.keys(event!.payload)).not.toContain("errorMessage");
  });

  test("a repeated failure for the same job records once and alerts once", async () => {
    const fixture = await seedFixture({ parentCount: 0 });
    const log = { warn: () => undefined, error: () => undefined };
    const params = {
      job: {
        id: "job-100",
        name: "dispatch-notification",
        data: dispatchJob(fixture),
        attemptsMade: 5,
        finishedOn: Date.now(),
      },
      error: new Error("boom"),
      databaseUrl: databaseUrl!,
      queueName: "notifications",
      log,
    };

    const first = await handleDeadLetter(params);
    const second = await handleDeadLetter(params);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const [rows] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.notification_dead_letters
      WHERE school_id = ${fixture.schoolId}::uuid
    `;
    const [events] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.outbox_events
      WHERE school_id = ${fixture.schoolId}::uuid
    `;
    expect(rows!.count).toBe(1);
    expect(events!.count).toBe(1);
  });
});
