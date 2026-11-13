/**
 * School-event notices and the generic push consumer, against a real migrated database.
 *
 * Skips unless TEST_DATABASE_URL points at a database already migrated to head (the workers test
 * convention -- see attendance-alert.test.ts).
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { claimPushes, pushSchoolNotifications } from "../push-consumer";
import { notifySchoolEvents } from "../school-events";

import type { PushDevice, PushMessage, PushSender } from "../push";
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
  studentId: string;
  studentUserId: string;
  parentUserId: string;
  teacherUserId: string;
  classId: string;
  courseId: string;
}

let seq = 0;

/** A school with one class, one enrolled student with an account, and one linked parent. */
async function seed(): Promise<Fixture> {
  seq += 1;
  const tag = `notify${seq}-${Date.now().toString(36)}`;
  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const email = `${tag}@admin.local`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`Notify ${tag}`}, ${email}, ${email}, ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const user = async (prefix: string, name: string) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${`${prefix}-${tag}@t.local`}, ${`${prefix}-${tag}@t.local`},
                ${name}, 'active')
        RETURNING id
      `;
      return row!.id;
    };
    const studentUserId = await user("s", "Student");
    const parentUserId = await user("p", "Parent");
    const teacherUserId = await user("t", "Teacher");

    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${studentUserId}::uuid, ${`ADM-${tag}`}, 'Amina', 'Tazi', 'enrolled')
      RETURNING id
    `;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}::uuid, 'Tazi family', ${parentUserId}::uuid)
      RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${parentUserId}::uuid, ${student!.id}::uuid, 'guardian')
    `;

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
      VALUES (${schoolId}::uuid, ${subject!.id}::uuid, ${`C-${tag}`}, 'Physics', 'active')
      RETURNING id
    `;
    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${schoolId}::uuid, ${`R-${tag}`}, ${`Room ${tag}`}, 'physical', 30, 'Main Building')
      RETURNING id
    `;
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
    await tx`
      INSERT INTO app.enrollments (school_id, class_id, student_id)
      VALUES (${schoolId}::uuid, ${cls!.id}::uuid, ${student!.id}::uuid)
    `;

    return {
      schoolId,
      studentId: student!.id,
      studentUserId,
      parentUserId,
      teacherUserId,
      classId: cls!.id,
      courseId: course!.id,
    };
  });
}

/** Run `fn` as studafy_admin inside the school's tenant scope. */
async function asAdmin<T>(schoolId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  });
}

async function emitEvent(schoolId: string, eventName: string, payload: Record<string, unknown>) {
  await asAdmin(
    schoolId,
    (tx) => tx`
    INSERT INTO app.outbox_events (school_id, event_name, payload)
    VALUES (${schoolId}::uuid, ${eventName}, ${tx.json(payload as never)})
  `,
  );
}

async function inbox(schoolId: string) {
  return asAdmin(
    schoolId,
    (tx) => tx<
      {
        user_id: string;
        notification_type: string;
        title: string;
        body: string;
        metadata: Record<string, string>;
      }[]
    >`
    SELECT user_id, notification_type::text AS notification_type, title, body, metadata
    FROM app.notifications
    WHERE school_id = ${schoolId}::uuid
    ORDER BY created_at, user_id
  `,
  );
}

async function createAssignment(f: Fixture, title: string): Promise<string> {
  return asAdmin(f.schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.assignments
        (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, status, assigned_at, due_at, max_score)
      VALUES (${f.schoolId}::uuid, ${f.classId}::uuid, ${f.teacherUserId}::uuid,
              ${f.teacherUserId}::uuid, ${title}, 'published', now(), '2026-11-20T12:00:00Z', 20)
      RETURNING id
    `;
    return row!.id;
  });
}

describeDb("school event notices", () => {
  test("a published assignment tells the student and the parent, once", async () => {
    const f = await seed();
    const assignmentId = await createAssignment(f, "Gravity");
    await emitEvent(f.schoolId, "assignment.published", { assignmentId, courseId: f.courseId });

    const first = await notifySchoolEvents(sql, f.schoolId, 50);
    expect(first).toEqual({ events: 1, notifications: 2 });

    const rows = await inbox(f.schoolId);
    const student = rows.find((row) => row.user_id === f.studentUserId)!;
    const parent = rows.find((row) => row.user_id === f.parentUserId)!;
    expect(student.notification_type).toBe("ASSIGNMENT_PUBLISHED");
    expect(student.title).toBe("New assignment: Gravity");
    expect(student.body).toBe("Physics · due 2026-11-20");
    expect(student.metadata.route).toBe(`/courses/${f.courseId}/assignments/${assignmentId}`);
    expect(parent.body).toBe("Amina Tazi · Physics · due 2026-11-20");
    expect(parent.metadata.route).toBe("/");

    // Consumed: a second pass finds nothing and writes nothing.
    expect(await notifySchoolEvents(sql, f.schoolId, 50)).toEqual({ events: 0, notifications: 0 });
    expect(await inbox(f.schoolId)).toHaveLength(2);
  });

  test("a released mark tells the student and the parent the score", async () => {
    const f = await seed();
    const assignmentId = await createAssignment(f, "Forces");
    const submissionId = await asAdmin(f.schoolId, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.assignment_submissions
          (school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at,
           graded_at, graded_by_user_id, score, grade_status)
        VALUES (${f.schoolId}::uuid, ${assignmentId}::uuid, ${f.studentId}::uuid,
                ${f.studentUserId}::uuid, 'graded', now(), now(), ${f.teacherUserId}::uuid, 17, 'published')
        RETURNING id
      `;
      return row!.id;
    });
    await emitEvent(f.schoolId, "submission.graded", {
      submissionId,
      assignmentId,
      studentId: f.studentId,
    });

    expect(await notifySchoolEvents(sql, f.schoolId, 50)).toEqual({ events: 1, notifications: 2 });
    const rows = await inbox(f.schoolId);
    expect(rows.map((row) => row.notification_type)).toEqual([
      "ASSIGNMENT_GRADED",
      "ASSIGNMENT_GRADED",
    ]);
    expect(rows.find((row) => row.user_id === f.studentUserId)!.body).toBe("Score 17 / 20");
  });

  test("a submitted register tells only the absent student's parent, in Arabic when chosen", async () => {
    const f = await seed();
    await asAdmin(
      f.schoolId,
      (tx) => tx`
      INSERT INTO app.user_notification_settings (school_id, user_id, locale)
      VALUES (${f.schoolId}::uuid, ${f.parentUserId}::uuid, 'ar')
    `,
    );
    const sessionId = await asAdmin(f.schoolId, async (tx) => {
      const [session] = await tx<{ id: string; created_at: Date }[]>`
        INSERT INTO app.attendance_sessions (school_id, class_id, session_date, period, status, taken_by_user_id)
        VALUES (${f.schoolId}::uuid, ${f.classId}::uuid, '2026-11-12', 1::smallint, 'submitted',
                ${f.teacherUserId}::uuid)
        RETURNING id, created_at
      `;
      await tx`
        INSERT INTO app.attendance_records
          (school_id, attendance_session_id, session_created_at, student_id, status, recorded_by_user_id)
        VALUES (${f.schoolId}::uuid, ${session!.id}::uuid, ${session!.created_at}, ${f.studentId}::uuid,
                'absent', ${f.teacherUserId}::uuid)
      `;
      return session!.id;
    });
    await emitEvent(f.schoolId, "attendance.sessionSubmitted", { sessionId, classId: f.classId });

    expect(await notifySchoolEvents(sql, f.schoolId, 50)).toEqual({ events: 1, notifications: 1 });
    const [row] = await inbox(f.schoolId);
    expect(row!.user_id).toBe(f.parentUserId);
    expect(row!.notification_type).toBe("ATTENDANCE_MARKED");
    expect(row!.title).toBe("تسجيل غياب لـ Amina Tazi");
    expect(row!.metadata.route).toBe("/parent/alerts");
  });

  test("an event older than two days is consumed without notifying", async () => {
    const f = await seed();
    const assignmentId = await createAssignment(f, "Old news");
    await emitEvent(f.schoolId, "assignment.published", { assignmentId, courseId: f.courseId });
    const later = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    expect(await notifySchoolEvents(sql, f.schoolId, 50, later)).toEqual({
      events: 1,
      notifications: 0,
    });
    expect(await inbox(f.schoolId)).toHaveLength(0);
  });
});

function recordingSender(): PushSender & {
  sent: { message: PushMessage; devices: PushDevice[] }[];
} {
  const sent: { message: PushMessage; devices: PushDevice[] }[] = [];
  return {
    sent,
    async send(message, devices) {
      sent.push({ message, devices });
      return {
        unregisteredDeviceIds: devices.filter((d) => d.token === "dead").map((d) => d.id),
        sent: devices.length,
        dryRun: true,
      };
    },
  };
}

const noop = (): undefined => undefined;
const silent = { info: noop, warn: noop, error: noop };

async function addNotification(f: Fixture, userId: string, type = "DIRECT_MESSAGE") {
  await asAdmin(
    f.schoolId,
    (tx) => tx`
    INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
    VALUES (${f.schoolId}::uuid, ${userId}::uuid, ${type}::app.notification_type,
            'New message from Ms Noor', 'See you tomorrow', ${tx.json({ route: "/messages/c-1" })})
  `,
  );
}

async function addDevice(f: Fixture, userId: string, token: string) {
  await asAdmin(
    f.schoolId,
    (tx) => tx`
    INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform)
    VALUES (${f.schoolId}::uuid, ${userId}::uuid, ${token}, 'ios')
  `,
  );
}

describeDb("push consumer", () => {
  test("pushes any inbox row to the recipient's devices, once, and prunes dead tokens", async () => {
    const f = await seed();
    await addDevice(f, f.parentUserId, "live");
    await addDevice(f, f.parentUserId, "dead");
    await addNotification(f, f.parentUserId);
    const sender = recordingSender();

    const result = await pushSchoolNotifications(sql, sender, f.schoolId, 100, silent);
    expect(result).toEqual({ claimed: 1, sent: 2, skipped: 0 });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.message).toMatchObject({
      title: "New message from Ms Noor",
      body: "See you tomorrow",
      route: "/messages/c-1",
      notificationType: "DIRECT_MESSAGE",
    });

    // Stamped: nothing left to send.
    expect((await pushSchoolNotifications(sql, sender, f.schoolId, 100, silent)).claimed).toBe(0);
    const live = await asAdmin(
      f.schoolId,
      (tx) => tx<{ fcm_token: string }[]>`
      SELECT fcm_token FROM app.user_devices
      WHERE school_id = ${f.schoolId}::uuid AND revoked_at IS NULL
    `,
    );
    expect(live.map((d) => d.fcm_token)).toEqual(["live"]);
  });

  test("respects a turned-off push preference and skips users without devices", async () => {
    const f = await seed();
    await addDevice(f, f.parentUserId, "live");
    await asAdmin(
      f.schoolId,
      (tx) => tx`
      INSERT INTO app.notification_preferences (school_id, user_id, notification_type, channel, enabled)
      VALUES (${f.schoolId}::uuid, ${f.parentUserId}::uuid, 'DIRECT_MESSAGE', 'push', false)
      ON CONFLICT (user_id, notification_type, channel) DO UPDATE SET enabled = false
    `,
    );
    await addNotification(f, f.parentUserId);
    await addNotification(f, f.studentUserId);

    const { claimed, planned } = await claimPushes(sql, f.schoolId, 100);
    expect(claimed).toBe(2);
    expect(planned).toHaveLength(0);
  });

  test("a stale row is stamped without a push", async () => {
    const f = await seed();
    await addDevice(f, f.parentUserId, "live");
    await addNotification(f, f.parentUserId);
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const { claimed, planned } = await claimPushes(sql, f.schoolId, 100, later);
    expect(claimed).toBe(1);
    expect(planned).toHaveLength(0);
  });
});
