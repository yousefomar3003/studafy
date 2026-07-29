/**
 * Attendance alert engine (ST-110).
 *
 * The pure evaluation functions are unit-tested and always run. Everything that proves the actual
 * guarantee — that a parent is alerted exactly once per breach under retries and concurrency —
 * needs a real database, because the guarantee *is* a unique index. Those tests follow the
 * packages/db/tests convention: skip unless TEST_DATABASE_URL is set, run the real migrations
 * against a disposable database, assert against real rows.
 *
 * This is the first DB-touching test in apps/workers; the existing suites all use hand-written
 * fakes because the two pre-existing processors have no tests at all.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  buildDedupKey,
  countAbsencesInWindow,
  countConsecutiveAbsences,
  DEFAULT_ALERT_RULES,
  evaluateRules,
  processAttendanceAlert,
} from "../attendance-alert.worker";

import type { AttendanceAlertRule } from "../attendance-alert.worker";
import type { Sql } from "postgres";

// ---------------------------------------------------------------------------
// Pure evaluation — no database
// ---------------------------------------------------------------------------

const day = (session_date: string, absent: boolean) => ({ session_date, absent });

describe("countConsecutiveAbsences", () => {
  test("counts an unbroken run ending on the boundary date", () => {
    const days = [
      day("2026-07-29", true),
      day("2026-07-28", true),
      day("2026-07-27", true),
      day("2026-07-24", false),
    ];
    expect(countConsecutiveAbsences(days, "2026-07-29")).toBe(3);
  });

  test("stops at the first present day", () => {
    const days = [day("2026-07-29", true), day("2026-07-28", false), day("2026-07-27", true)];
    expect(countConsecutiveAbsences(days, "2026-07-29")).toBe(1);
  });

  test("returns 0 when the student was present on the boundary date", () => {
    const days = [day("2026-07-29", false), day("2026-07-28", true), day("2026-07-27", true)];
    expect(countConsecutiveAbsences(days, "2026-07-29")).toBe(0);
  });

  test("returns 0 when the run does not reach the boundary date", () => {
    // Three absences, but the latest is two days stale — history, not an alert.
    const days = [day("2026-07-27", true), day("2026-07-26", true), day("2026-07-25", true)];
    expect(countConsecutiveAbsences(days, "2026-07-29")).toBe(0);
  });

  test("a gap with no session at all does not break the run", () => {
    // 2026-07-25/26 is a weekend: no rows, so the run spans it.
    const days = [day("2026-07-27", true), day("2026-07-24", true), day("2026-07-23", true)];
    expect(countConsecutiveAbsences(days, "2026-07-27")).toBe(3);
  });

  test("is order-independent", () => {
    const days = [day("2026-07-27", true), day("2026-07-29", true), day("2026-07-28", true)];
    expect(countConsecutiveAbsences(days, "2026-07-29")).toBe(3);
  });
});

describe("countAbsencesInWindow", () => {
  test("counts absent days inside the window, inclusive of both ends", () => {
    const days = [
      day("2026-07-29", true),
      day("2026-07-28", false),
      day("2026-07-27", true),
      day("2026-07-26", true),
    ];
    expect(countAbsencesInWindow(days, "2026-07-29", 4)).toBe(3);
  });

  test("ignores absences older than the window", () => {
    const days = [day("2026-07-29", true), day("2026-07-20", true), day("2026-07-19", true)];
    expect(countAbsencesInWindow(days, "2026-07-29", 3)).toBe(1);
  });
});

describe("evaluateRules", () => {
  const consecutive: AttendanceAlertRule = {
    rule_type: "consecutive_days",
    threshold_value: 3,
    window_days: null,
  };
  const period: AttendanceAlertRule = {
    rule_type: "period_count",
    threshold_value: 4,
    window_days: 10,
  };

  test("returns only the rules the student crossed", () => {
    const days = [day("2026-07-29", true), day("2026-07-28", true), day("2026-07-27", true)];
    const breaches = evaluateRules([consecutive, period], days, "2026-07-29");
    expect(breaches.map((b) => b.rule.rule_type)).toEqual(["consecutive_days"]);
    expect(breaches[0]!.absentDays).toBe(3);
  });

  test("returns nothing below threshold", () => {
    const days = [day("2026-07-29", true), day("2026-07-28", false)];
    expect(evaluateRules([consecutive, period], days, "2026-07-29")).toEqual([]);
  });

  test("the built-in default alerts at three consecutive days", () => {
    const days = [day("2026-07-29", true), day("2026-07-28", true), day("2026-07-27", true)];
    expect(evaluateRules(DEFAULT_ALERT_RULES, days, "2026-07-29")).toHaveLength(1);
  });
});

describe("buildDedupKey", () => {
  test("carries rule, threshold and date, and nothing already on the row", () => {
    const rule: AttendanceAlertRule = {
      rule_type: "consecutive_days",
      threshold_value: 3,
      window_days: null,
    };
    expect(buildDedupKey(rule, "2026-07-29")).toBe("consecutive_days:3:2026-07-29");
  });

  test("a raised threshold is a different key, so it can re-alert", () => {
    const three = buildDedupKey(
      { rule_type: "consecutive_days", threshold_value: 3, window_days: null },
      "2026-07-29",
    );
    const five = buildDedupKey(
      { rule_type: "consecutive_days", threshold_value: 5, window_days: null },
      "2026-07-29",
    );
    expect(three).not.toBe(five);
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
  parentIds: string[];
  classId: string;
  sessionDates: string[];
}

let fixtureSeq = 0;

/**
 * A school with one student, `parentCount` linked parents, and one attendance session per entry in
 * `absencePattern` — `true` meaning the student was marked absent that day.
 *
 * Seeded as studafy_admin: role_scope_visibility is a RESTRICTIVE SELECT policy and PostgreSQL
 * applies it to INSERT ... RETURNING too, so the app role cannot read back rows it just wrote for
 * a student it has no claim on.
 */
async function seedFixture(
  absencePattern: boolean[],
  options: { parentCount?: number; startDate?: string; sessionStatus?: string } = {},
): Promise<Fixture> {
  const parentCount = options.parentCount ?? 1;
  const startDate = options.startDate ?? "2026-07-20";
  const sessionStatus = options.sessionStatus ?? "submitted";
  fixtureSeq += 1;
  const tag = `alert${fixtureSeq}-${Date.now().toString(36)}`;

  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    // Column list mirrors createSchool in apps/api/tests/harness/factories.ts — apps/workers
    // cannot import that harness, but the required-column set is the same and drifting from it
    // just means rediscovering each NOT NULL one failed test at a time.
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const schoolEmail = `${tag}@admin.local`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`Alert ${tag}`}, ${schoolEmail}, ${schoolEmail},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [studentUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${`s-${tag}@t.local`}, ${`s-${tag}@t.local`}, 'Student', 'active')
      RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${studentUser!.id}::uuid, ${`ADM-${tag}`}, 'Amina', 'Tazi', 'enrolled')
      RETURNING id
    `;
    const studentId = student!.id;

    const parentIds: string[] = [];
    for (let i = 0; i < parentCount; i += 1) {
      const [parent] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${`p${i}-${tag}@t.local`}, ${`p${i}-${tag}@t.local`}, 'Parent', 'active')
        RETURNING id
      `;
      await tx`
        INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship)
        VALUES (${schoolId}::uuid, ${parent!.id}::uuid, ${studentId}::uuid, 'guardian')
      `;
      parentIds.push(parent!.id);
    }

    // Minimal academic scaffolding for a class. Column lists mirror the harness factories.
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
      VALUES (${schoolId}::uuid, ${subject!.id}::uuid, ${`C-${tag}`}, ${`Course ${tag}`}, 'active')
      RETURNING id
    `;
    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${schoolId}::uuid, ${`R-${tag}`}, ${`Room ${tag}`}, 'physical', 30, 'Main Building')
      RETURNING id
    `;
    const [teacherUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${`t-${tag}@t.local`}, ${`t-${tag}@t.local`}, 'Teacher', 'active')
      RETURNING id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${schoolId}::uuid, ${teacherUser!.id}::uuid, ${`E-${tag}`}, 'active')
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
      VALUES (${schoolId}::uuid, ${cls!.id}::uuid, ${studentId}::uuid)
    `;

    const sessionDates: string[] = [];
    for (const [index, absent] of absencePattern.entries()) {
      const sessionDate = shift(startDate, index);
      sessionDates.push(sessionDate);

      const [session] = await tx<{ id: string; created_at: Date }[]>`
        INSERT INTO app.attendance_sessions
          (school_id, class_id, session_date, period, status, taken_by_user_id)
        VALUES (${schoolId}::uuid, ${cls!.id}::uuid, ${sessionDate}::date, 1::smallint,
                ${sessionStatus}::app.attendance_session_status, ${teacherUser!.id}::uuid)
        RETURNING id, created_at
      `;
      await tx`
        INSERT INTO app.attendance_records
          (school_id, attendance_session_id, session_created_at, student_id, status, recorded_by_user_id)
        VALUES (${schoolId}::uuid, ${session!.id}::uuid, ${session!.created_at},
                ${studentId}::uuid, ${absent ? "absent" : "present"}::app.attendance_status,
                ${teacherUser!.id}::uuid)
      `;
    }

    return { schoolId, studentId, parentIds, classId: cls!.id, sessionDates };
  });
}

function shift(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function countNotifications(schoolId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.notifications
    WHERE school_id = ${schoolId}::uuid AND notification_type = 'ATTENDANCE_ALERT'
  `;
  return row!.count;
}

async function countAlertLogs(schoolId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.attendance_alert_logs WHERE school_id = ${schoolId}::uuid
  `;
  return row!.count;
}

async function setRule(
  schoolId: string,
  rule: AttendanceAlertRule,
  isActive = true,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.attendance_alert_rules (school_id, rule_type, threshold_value, window_days, is_active)
      VALUES (${schoolId}::uuid, ${rule.rule_type}::app.attendance_alert_rule_type,
              ${rule.threshold_value}::smallint, ${rule.window_days}::smallint, ${isActive})
      ON CONFLICT (school_id, rule_type) DO UPDATE
        SET threshold_value = EXCLUDED.threshold_value,
            window_days = EXCLUDED.window_days,
            is_active = EXCLUDED.is_active
    `;
  });
}

describeDb("processAttendanceAlert", () => {
  test("alerts every linked parent once when the consecutive threshold is crossed", async () => {
    const f = await seedFixture([true, true, true], { parentCount: 2 });
    const boundary = f.sessionDates.at(-1)!;

    const result = await processAttendanceAlert(
      {
        schoolId: f.schoolId,
        attendanceSessionId: f.classId,
        sessionDate: boundary,
        studentIds: [f.studentId],
      },
      databaseUrl!,
      "job-1",
    );

    expect(result.alertsSent).toBe(2);
    expect(result.duplicatesSkipped).toBe(0);
    expect(await countNotifications(f.schoolId)).toBe(2);
    expect(await countAlertLogs(f.schoolId)).toBe(2);

    const logs = await sql<Record<string, unknown>[]>`
      SELECT parent_user_id, rule_type::text AS rule_type, dedup_key, notification_id, trigger_job_id
      FROM app.attendance_alert_logs WHERE school_id = ${f.schoolId}::uuid ORDER BY parent_user_id
    `;
    expect(logs.map((l) => l.parent_user_id)).toEqual([...f.parentIds].sort());
    expect(logs[0]!.rule_type).toBe("consecutive_days");
    expect(logs[0]!.dedup_key).toBe(`consecutive_days:3:${boundary}`);
    expect(logs[0]!.trigger_job_id).toBe("job-1");
    // Claim-then-notify leaves this set only when delivery actually happened.
    expect(logs[0]!.notification_id).not.toBeNull();
  });

  test("writes nothing when the threshold is not reached", async () => {
    const f = await seedFixture([true, false, true]);
    const result = await processAttendanceAlert(
      {
        schoolId: f.schoolId,
        attendanceSessionId: f.classId,
        sessionDate: f.sessionDates.at(-1)!,
        studentIds: [f.studentId],
      },
      databaseUrl!,
    );

    expect(result.alertsSent).toBe(0);
    expect(await countAlertLogs(f.schoolId)).toBe(0);
    expect(await countNotifications(f.schoolId)).toBe(0);
  });

  test("a present day resets the run", async () => {
    // Absent, absent, present, absent — the run ending today is 1, not 3.
    const f = await seedFixture([true, true, false, true]);
    const result = await processAttendanceAlert(
      {
        schoolId: f.schoolId,
        attendanceSessionId: f.classId,
        sessionDate: f.sessionDates.at(-1)!,
        studentIds: [f.studentId],
      },
      databaseUrl!,
    );
    expect(result.alertsSent).toBe(0);
  });

  test("replaying the same job writes nothing the second time", async () => {
    const f = await seedFixture([true, true, true], { parentCount: 2 });
    const job = {
      schoolId: f.schoolId,
      attendanceSessionId: f.classId,
      sessionDate: f.sessionDates.at(-1)!,
      studentIds: [f.studentId],
    };

    const first = await processAttendanceAlert(job, databaseUrl!, "job-a");
    const second = await processAttendanceAlert(job, databaseUrl!, "job-b");

    expect(first.alertsSent).toBe(2);
    expect(second.alertsSent).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
    expect(await countNotifications(f.schoolId)).toBe(2);
  });

  test("concurrent invocations still produce exactly one alert per parent", async () => {
    const f = await seedFixture([true, true, true], { parentCount: 2 });
    const job = {
      schoolId: f.schoolId,
      attendanceSessionId: f.classId,
      sessionDate: f.sessionDates.at(-1)!,
      studentIds: [f.studentId],
    };

    // The real duplicate-suppression proof: two processors racing on the same breach, which is
    // what a BullMQ retry overlapping a slow first attempt actually looks like. Only the unique
    // index can arbitrate this — no amount of read-then-write could.
    const [a, b] = await Promise.all([
      processAttendanceAlert(job, databaseUrl!, "job-x"),
      processAttendanceAlert(job, databaseUrl!, "job-y"),
    ]);

    expect(a.alertsSent + b.alertsSent).toBe(2);
    expect(await countAlertLogs(f.schoolId)).toBe(2);
    expect(await countNotifications(f.schoolId)).toBe(2);
  });

  test("a student with no linked parent is evaluated and emits nothing", async () => {
    const f = await seedFixture([true, true, true], { parentCount: 0 });
    const result = await processAttendanceAlert(
      {
        schoolId: f.schoolId,
        attendanceSessionId: f.classId,
        sessionDate: f.sessionDates.at(-1)!,
        studentIds: [f.studentId],
      },
      databaseUrl!,
    );

    expect(result.studentsEvaluated).toBe(1);
    expect(result.alertsSent).toBe(0);
    // Nothing claimed, so linking a parent tomorrow can still alert on a fresh breach.
    expect(await countAlertLogs(f.schoolId)).toBe(0);
  });

  test("a school's own rule overrides the built-in default", async () => {
    const f = await seedFixture([true, true]);
    await setRule(f.schoolId, {
      rule_type: "consecutive_days",
      threshold_value: 2,
      window_days: null,
    });

    const result = await processAttendanceAlert(
      {
        schoolId: f.schoolId,
        attendanceSessionId: f.classId,
        sessionDate: f.sessionDates.at(-1)!,
        studentIds: [f.studentId],
      },
      databaseUrl!,
    );

    // Two absences would not reach the default of three.
    expect(result.alertsSent).toBe(1);
    const [log] = await sql<{ dedup_key: string }[]>`
      SELECT dedup_key FROM app.attendance_alert_logs WHERE school_id = ${f.schoolId}::uuid
    `;
    expect(log!.dedup_key).toBe(`consecutive_days:2:${f.sessionDates.at(-1)!}`);
  });

  test("an inactive rule falls back to the default rather than disabling alerting", async () => {
    const f = await seedFixture([true, true]);
    await setRule(
      f.schoolId,
      { rule_type: "consecutive_days", threshold_value: 2, window_days: null },
      false,
    );

    const result = await processAttendanceAlert(
      {
        schoolId: f.schoolId,
        attendanceSessionId: f.classId,
        sessionDate: f.sessionDates.at(-1)!,
        studentIds: [f.studentId],
      },
      databaseUrl!,
    );

    // The default threshold of 3 is not met by two absences.
    expect(result.alertsSent).toBe(0);
  });

  test("period_count counts absences across a window that a consecutive rule would miss", async () => {
    // absent, present, absent, present, absent — no run, but three in five days.
    const f = await seedFixture([true, false, true, false, true]);
    await setRule(f.schoolId, {
      rule_type: "period_count",
      threshold_value: 3,
      window_days: 5,
    });

    const result = await processAttendanceAlert(
      {
        schoolId: f.schoolId,
        attendanceSessionId: f.classId,
        sessionDate: f.sessionDates.at(-1)!,
        studentIds: [f.studentId],
      },
      databaseUrl!,
    );

    expect(result.alertsSent).toBe(1);
  });

  test("emits one attendance.alertRaised outbox row per breach, not per parent", async () => {
    const f = await seedFixture([true, true, true], { parentCount: 3 });
    await processAttendanceAlert(
      {
        schoolId: f.schoolId,
        attendanceSessionId: f.classId,
        sessionDate: f.sessionDates.at(-1)!,
        studentIds: [f.studentId],
      },
      databaseUrl!,
    );

    const events = await sql<{ event_name: string; payload: Record<string, unknown> }[]>`
      SELECT event_name, payload FROM app.outbox_events
      WHERE school_id = ${f.schoolId}::uuid AND event_name = 'attendance.alertRaised'
    `;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.studentId).toBe(f.studentId);
    expect(events[0]!.payload.absentDays).toBe(3);
    expect(events[0]!.payload.parentUserIds).toHaveLength(3);
  });

  test("a cancelled session is not evidence of absence", async () => {
    const f = await seedFixture([true, true, true], { sessionStatus: "cancelled" });
    const result = await processAttendanceAlert(
      {
        schoolId: f.schoolId,
        attendanceSessionId: f.classId,
        sessionDate: f.sessionDates.at(-1)!,
        studentIds: [f.studentId],
      },
      databaseUrl!,
    );
    expect(result.alertsSent).toBe(0);
  });

  test("the alert log is append-only for the runtime role", async () => {
    const f = await seedFixture([true, true, true]);
    await processAttendanceAlert(
      {
        schoolId: f.schoolId,
        attendanceSessionId: f.classId,
        sessionDate: f.sessionDates.at(-1)!,
        studentIds: [f.studentId],
      },
      databaseUrl!,
    );

    // DELETE is withheld from studafy_app; UPDATE is granted only so the worker can stamp
    // notification_id after the claim.
    await expect(
      sql.begin(async (tx) => {
        await tx`
          SELECT set_config('role', 'studafy_app', true),
                 set_config('app.school_id', ${f.schoolId}, true)
        `;
        await tx`DELETE FROM app.attendance_alert_logs WHERE school_id = ${f.schoolId}::uuid`;
      }),
    ).rejects.toThrow();

    expect(await countAlertLogs(f.schoolId)).toBe(1);
  });

  test("an empty student list is a no-op", async () => {
    const result = await processAttendanceAlert(
      {
        schoolId: "00000000-0000-0000-0000-000000000000",
        attendanceSessionId: "00000000-0000-0000-0000-000000000000",
        sessionDate: "2026-07-29",
        studentIds: [],
      },
      databaseUrl!,
    );
    expect(result).toEqual({
      processed: true,
      studentsEvaluated: 0,
      alertsSent: 0,
      duplicatesSkipped: 0,
    });
  });
});
