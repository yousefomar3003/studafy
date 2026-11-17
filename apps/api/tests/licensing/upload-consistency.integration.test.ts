/**
 * Upload consistency for the Student AI content bonus against a real database (phase 4;
 * docs/billing/ai-upload-consistency.md): school days from the timetable week minus calendar
 * holidays, in the school's timezone, up to today; a class counted on the days a class material was
 * published for it (students' own and assignment AI sources never); the classes that have Student
 * AI; per-teacher and per-school averages; the content-bonus tier on the licence's values; tenant
 * isolation; and the routes' permissions.
 *
 * The school's week is Sunday to Thursday and its timezone Asia/Dubai (UTC+4). The measured
 * fortnight, Sunday 1 to Saturday 14 November 2026, has 10 teaching days; Tuesday 3 November is a
 * holiday, leaving 9.
 */

import { ROLES } from "@studafy/constants";
import { schoolDaysBetween } from "@studafy/license-pricing";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import {
  contentBonusTiersFor,
  resolveAiProgrammeStamp,
  runLicenseChange,
  saveSchoolOverride,
  uploadConsistency,
  uploadConsistencyView,
} from "../../src/modules/licensing";
import { readLicense } from "../../src/modules/licensing/service";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createStudent,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import { insertOptIn, insertOptInWindow, releaseTestOptIn } from "./programme-optins";

import type { LicenseActor, LicensingDeps } from "../../src/modules/licensing";
import type { SchoolOverrideInput } from "../../src/modules/licensing/ai-programme";
import type { TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const logger = createLogger({ destination: () => undefined });

let db: TestDatabase;
let hq: string;
let operator: LicenseActor;
let studentTier = "";

function deps(): LicensingDeps {
  return {
    database: db.sql,
    redis: null,
    logger,
    providers: { stripe: null, googlePlay: null },
    storage: null,
  };
}

async function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

/** As the runtime role for `userId` in `schoolId`, as a school's request runs. */
async function asApp<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);

  hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq, { email: "upload-ops@studafy.test" });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };

  await asAdmin(hq, async (tx) => {
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_ai_upload', 'Student AI', 'student', 3) RETURNING id::text AS id
    `;
    studentTier = student!.id;
  });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

// ---------------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------------

interface Fixture {
  schoolId: string;
  adminUserId: string;
  licenseId: string;
  teachers: { lead: string; coTeacher: string; other: string };
  teacherUserIds: { lead: string; coTeacher: string; other: string };
  classes: Record<"a" | "b" | "noSeat" | "unseated" | "withdrawn" | "laterTerm", string>;
  students: { seated: string; unseated: string; withdrawn: string; noSeat: string };
}

let codeCounter = 0;
const code = (prefix: string) => `${prefix}-${++codeCounter}`;

async function fixture(name: string): Promise<Fixture> {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const admin = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, admin.id, ROLES.ORG_ADMIN);

  const lead = await createTeacher(db.sql, schoolId);
  const coTeacher = await createTeacher(db.sql, schoolId);
  const other = await createTeacher(db.sql, schoolId);
  const seated = await createStudent(db.sql, schoolId);
  const unseated = await createStudent(db.sql, schoolId);
  const withdrawn = await createStudent(db.sql, schoolId);
  const noSeat = await createStudent(db.sql, schoolId);

  return asAdmin(schoolId, async (tx) => {
    await tx`
      INSERT INTO app.school_settings (school_id, timezone, school_days)
      VALUES (${schoolId}::uuid, 'Asia/Dubai', '{7,1,2,3,4}')
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${code("AY")}, 'Year 2026-27', '2026-09-01', '2027-06-30', 'active')
      RETURNING id::text AS id
    `;
    const term = async (seq: number, startsOn: string, endsOn: string) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.terms
          (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
        VALUES (${schoolId}::uuid, ${year!.id}::uuid, ${code("T")}, ${`Term ${seq}`}, ${seq},
                ${startsOn}::date, ${endsOn}::date, 'active')
        RETURNING id::text AS id
      `;
      return row!.id;
    };
    const term1 = await term(1, "2026-09-01", "2027-01-31");
    const term2 = await term(2, "2027-02-01", "2027-06-30");
    const [subject] = await tx<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${schoolId}::uuid, ${code("SUB")}, 'Science', 'active') RETURNING id::text AS id
    `;
    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${schoolId}::uuid, ${code("RM")}, 'Room', 'physical', 30, 'Main')
      RETURNING id::text AS id
    `;
    const klass = async (courseName: string, leadTeacherId: string, termId: string) => {
      const [course] = await tx<{ id: string }[]>`
        INSERT INTO app.courses (school_id, subject_id, code, name, credit_hours, status)
        VALUES (${schoolId}::uuid, ${subject!.id}::uuid, ${code("CRS")}, ${courseName}, 1, 'active')
        RETURNING id::text AS id
      `;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.classes
          (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, status)
        VALUES (${schoolId}::uuid, ${course!.id}::uuid, ${year!.id}::uuid, ${termId}::uuid,
                ${leadTeacherId}::uuid, ${room!.id}::uuid, ${code("CLS")}, 'active')
        RETURNING id::text AS id
      `;
      return row!.id;
    };
    const classes = {
      a: await klass("Algebra", lead.id, term1),
      b: await klass("Biology", coTeacher.id, term1),
      noSeat: await klass("Chemistry", other.id, term1),
      unseated: await klass("Drama", other.id, term1),
      withdrawn: await klass("Economics", other.id, term1),
      laterTerm: await klass("French", lead.id, term2),
    };

    const enrol = (classId: string, studentId: string) => tx`
      INSERT INTO app.enrollments (school_id, class_id, student_id, enrolled_at, created_at, updated_at)
      VALUES (${schoolId}::uuid, ${classId}::uuid, ${studentId}::uuid, '2026-08-25T06:00:00Z',
              '2026-08-25T06:00:00Z', '2026-08-25T06:00:00Z')
    `;
    await enrol(classes.a, seated.id);
    await enrol(classes.b, seated.id);
    await enrol(classes.laterTerm, seated.id);
    await enrol(classes.noSeat, noSeat.id);
    await enrol(classes.unseated, unseated.id);
    await enrol(classes.withdrawn, withdrawn.id);

    // The lead teacher also teaches Biology on the approved timetable; a draft timetable naming the
    // "other" teacher for Algebra does not count.
    const version = async (status: "draft" | "approved", teacherId: string, classId: string) => {
      const [v] = await tx<{ id: string }[]>`
        INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name)
        VALUES (${schoolId}::uuid, ${year!.id}::uuid, ${term1}::uuid, ${code("TT")})
        RETURNING id::text AS id
      `;
      await tx`
        INSERT INTO app.timetable_slots
          (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
        VALUES (${schoolId}::uuid, ${v!.id}::uuid, ${classId}::uuid, ${teacherId}::uuid,
                ${room!.id}::uuid, 1, 1)
      `;
      if (status === "approved") {
        await tx`
          UPDATE app.timetable_versions SET status = 'pending', submitted_by_user_id = ${admin.id}::uuid
          WHERE id = ${v!.id}::uuid
        `;
        await tx`
          UPDATE app.timetable_versions SET status = 'approved', approved_by_user_id = ${admin.id}::uuid
          WHERE id = ${v!.id}::uuid
        `;
      }
    };
    await version("approved", lead.id, classes.b);
    await version("draft", other.id, classes.a);

    // An active licence for the school year, with three student seats.
    const [license] = await tx<{ id: string }[]>`
      INSERT INTO app.school_licenses
        (school_id, status, starts_at, ends_at, student_plan_id, student_seats, currency_id,
         created_by, activated_at, ai_programme_version_id)
      SELECT ${schoolId}::uuid, 'active', '2026-08-31T20:00:00Z', '2027-06-30T20:00:00Z',
             ${studentTier}::uuid, 3, c.id, ${operator.userId}::uuid, '2026-08-31T20:00:00Z',
             'a1000000-0000-4000-8000-000000000001'
      FROM app.currencies AS c WHERE c.code = 'USD'
      RETURNING id::text AS id
    `;
    // Student AI in the programme (000235): each seated student holds a programme opt-in on it.
    const windowId = await insertOptInWindow(tx, {
      schoolId,
      licenseId: license!.id,
      academicYearId: year!.id,
      openedBy: admin.id,
    });
    const seat = async (student: { id: string; userId: string }) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.license_seats
          (school_id, license_id, audience, user_id, student_id, assigned_at, assigned_by)
        VALUES (${schoolId}::uuid, ${license!.id}::uuid, 'student', ${student.userId}::uuid,
                ${student.id}::uuid, '2026-09-01T06:00:00Z', ${admin.id}::uuid)
        RETURNING id::text AS id
      `;
      const optInId = await insertOptIn(tx, {
        schoolId,
        licenseId: license!.id,
        academicYearId: year!.id,
        windowId,
        studentId: student.id,
        recordedBy: admin.id,
        startMonth: "2026-09-01",
        endMonth: "2027-06-01",
        monthlyPriceMinor: 600,
        seatId: row!.id,
        seatAssignedAt: "2026-09-01T06:00:00Z",
        optedInAt: "2026-08-30T06:00:00Z",
      });
      return { seatId: row!.id, optInId };
    };
    await seat(seated);
    const unseatedSeat = await seat(unseated);
    await seat(withdrawn);
    // Unseated in October (the opt-in released first, as the service does): had Student AI in
    // September and October, not in November.
    await releaseTestOptIn(
      tx,
      unseatedSeat.optInId,
      admin.id,
      "2026-11-01",
      "2026-10-15T06:00:00Z",
    );
    await tx`
      UPDATE app.license_seats
      SET unassigned_at = '2026-10-15T06:00:00Z', unassigned_by = ${admin.id}::uuid
      WHERE id = ${unseatedSeat.seatId}::uuid
    `;
    // Withdrew from Economics in October.
    await tx`
      UPDATE app.enrollments SET status = 'withdrawn', withdrawn_at = '2026-10-20T06:00:00Z'
      WHERE class_id = ${classes.withdrawn}::uuid
    `;

    return {
      schoolId,
      adminUserId: admin.id,
      licenseId: license!.id,
      teachers: { lead: lead.id, coTeacher: coTeacher.id, other: other.id },
      teacherUserIds: { lead: lead.userId, coTeacher: coTeacher.userId, other: other.userId },
      classes,
      students: {
        seated: seated.id,
        unseated: unseated.id,
        withdrawn: withdrawn.id,
        noSeat: noSeat.id,
      },
    };
  });
}

/** A class material published at `publishedAt` (an instant), as trg_materials_published stamps it. */
async function publish(
  f: Fixture,
  classId: string,
  publishedAt: string,
  extra: { kind?: "class" | "assignment"; assignmentId?: string } = {},
) {
  const kind = extra.kind ?? "class";
  await asAdmin(f.schoolId, (tx) => {
    const storageKey =
      kind === "class" ? `permanent/${f.schoolId}/materials/${crypto.randomUUID()}` : null;
    return tx`
      INSERT INTO app.materials
        (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, storage_key,
         original_file_name, mime_type, size_bytes, ingest_status, ingested_at, published_at,
         source_kind, assignment_id)
      VALUES (${f.schoolId}::uuid, ${classId}::uuid, ${f.teacherUserIds.lead}::uuid,
              ${f.teacherUserIds.lead}::uuid, 'Lesson', ${storageKey}, 'lesson.pdf',
              'application/pdf', 1024, 'ready', ${publishedAt}::timestamptz,
              ${publishedAt}::timestamptz, ${kind}, ${extra.assignmentId ?? null}::uuid)
    `;
  });
}

const FORTNIGHT = { from: "2026-11-01", to: "2026-11-14" };

async function holiday(f: Fixture, startsOn: string, endsOn: string) {
  await asAdmin(
    f.schoolId,
    (tx) =>
      tx`
      INSERT INTO app.school_events (school_id, created_by, title, kind, starts_on, ends_on)
      VALUES (${f.schoolId}::uuid, ${f.adminUserId}::uuid, 'Holiday', 'holiday',
              ${startsOn}::date, ${endsOn}::date)
    `,
  );
}

// ---------------------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------------------

describe("upload consistency", () => {
  let f: Fixture;

  beforeAll(async () => {
    if (!integrationEnabled) return;
    f = await fixture("Consistency School");
    // Tuesday 3 November is a holiday; a non-holiday calendar event does not take a day out.
    await holiday(f, "2026-11-03", "2026-11-03");
    await asAdmin(
      f.schoolId,
      (tx) =>
        tx`
        INSERT INTO app.school_events (school_id, created_by, title, kind, starts_on, ends_on)
        VALUES (${f.schoolId}::uuid, ${f.adminUserId}::uuid, 'Sports day', 'event',
                '2026-11-04', '2026-11-04')
      `,
    );

    // Algebra: Sunday 1, Monday 2 (twice), the holiday, Wednesday 4, and two that land on other
    // days only in Dubai time:
    //   * Wednesday 4 21:30 UTC is Thursday 5 01:30 in Dubai -> Thursday 5 counts;
    //   * Thursday 12 20:30 UTC is Friday 13 00:30 in Dubai -> a weekend day, nothing.
    for (const at of [
      "2026-11-01T05:00:00Z",
      "2026-11-02T05:00:00Z",
      "2026-11-02T09:00:00Z",
      "2026-11-03T05:00:00Z",
      "2026-11-04T05:00:00Z",
      "2026-11-04T21:30:00Z",
      "2026-11-12T20:30:00Z",
      // Saturday 31 October 20:30 UTC is Sunday 1 November 00:30 in Dubai: already counted.
      "2026-10-31T20:30:00Z",
    ]) {
      await publish(f, f.classes.a, at);
    }
    // Biology: every one of the 9 school days.
    for (const day of schoolDaysBetween(
      FORTNIGHT.from,
      FORTNIGHT.to,
      [7, 1, 2, 3, 4],
      [{ startsOn: "2026-11-03", endsOn: "2026-11-03" }],
    )) {
      await publish(f, f.classes.b, `${day}T08:00:00Z`);
    }
    // Uploads for classes that are not measured.
    await publish(f, f.classes.noSeat, "2026-11-01T08:00:00Z");
    await publish(f, f.classes.unseated, "2026-10-04T08:00:00Z");
  });

  integrationTest(
    "school days are the timetable week minus holidays, counted in the school's timezone",
    async () => {
      const report = await asAdmin(f.schoolId, (tx) => uploadConsistency(tx, FORTNIGHT));
      expect(report.timezone).toBe("Asia/Dubai");
      expect(report.schoolDays).toBe(9);
      expect(report.countedTo).toBe("2026-11-14");

      const algebra = report.classes.find((c) => c.classId === f.classes.a)!;
      // Sun 1, Mon 2, Wed 4, Thu 5 (Dubai): 4 of 9 -> 44.44% rounded down.
      expect(algebra).toMatchObject({
        courseName: "Algebra",
        schoolDays: 9,
        uploadDays: 4,
        consistencyBps: 4444,
      });
      const biology = report.classes.find((c) => c.classId === f.classes.b)!;
      expect(biology).toMatchObject({ schoolDays: 9, uploadDays: 9, consistencyBps: 10_000 });

      // The school: the mean of the two classes, rounded down.
      expect(report.classesCounted).toBe(2);
      expect(report.consistencyBps).toBe(7222);
    },
  );

  integrationTest(
    "only classes with a student holding a Student AI seat are measured",
    async () => {
      const report = await asAdmin(f.schoolId, (tx) => uploadConsistency(tx, FORTNIGHT));
      // Not Chemistry (no seat), Drama (seat unassigned in October), Economics (withdrew in October)
      // or French (its term has not started).
      expect(report.classes.map((c) => c.classId).sort()).toEqual(
        [f.classes.a, f.classes.b].sort(),
      );

      // In early October Drama's and Economics' students still had their seats and classes.
      const october = await asAdmin(f.schoolId, (tx) =>
        uploadConsistency(tx, { from: "2026-10-04", to: "2026-10-08" }),
      );
      expect(october.classes.map((c) => c.classId).sort()).toEqual(
        [f.classes.a, f.classes.b, f.classes.unseated, f.classes.withdrawn].sort(),
      );
      const drama = october.classes.find((c) => c.classId === f.classes.unseated)!;
      expect(drama).toMatchObject({ schoolDays: 5, uploadDays: 1, consistencyBps: 2000 });

      // A licence not yet in force in the period gives no class Student AI.
      await asAdmin(
        f.schoolId,
        (tx) =>
          tx`UPDATE app.school_licenses SET starts_at = '2026-11-20T00:00:00Z' WHERE id = ${f.licenseId}::uuid`,
      );
      try {
        const before = await asAdmin(f.schoolId, (tx) => uploadConsistency(tx, FORTNIGHT));
        expect(before.classes).toEqual([]);
        expect(before.consistencyBps).toBeNull();
      } finally {
        await asAdmin(
          f.schoolId,
          (tx) =>
            tx`UPDATE app.school_licenses SET starts_at = '2026-08-31T20:00:00Z' WHERE id = ${f.licenseId}::uuid`,
        );
      }
    },
  );

  integrationTest("students' own and assignment AI sources never count", async () => {
    const g = await fixture("Sources School");
    const [assignment] = await asAdmin(
      g.schoolId,
      (tx) =>
        tx<{ id: string }[]>`
        INSERT INTO app.assignments
          (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, due_at, max_score)
        VALUES (${g.schoolId}::uuid, ${g.classes.a}::uuid, ${g.teacherUserIds.lead}::uuid,
                ${g.teacherUserIds.lead}::uuid, 'Homework', '2026-12-01T00:00:00Z', 10)
        RETURNING id::text AS id
      `,
    );
    await publish(g, g.classes.a, "2026-11-01T08:00:00Z", {
      kind: "assignment",
      assignmentId: assignment!.id,
    });
    await asAdmin(
      g.schoolId,
      (tx) =>
        tx`
        INSERT INTO app.materials
          (school_id, owner_student_id, uploaded_by_user_id, last_edited_by_user_id, title,
           storage_key, original_file_name, mime_type, size_bytes, ingest_status, ingested_at,
           published_at, source_kind)
        SELECT ${g.schoolId}::uuid, s.id, s.user_id, s.user_id, 'My notes',
               ${`permanent/${g.schoolId}/ai-sources/${crypto.randomUUID()}`}, 'notes.pdf',
               'application/pdf', 1024, 'ready', '2026-11-02T08:00:00Z', '2026-11-02T08:00:00Z',
               'personal'
        FROM app.students AS s WHERE s.id = ${g.students.seated}::uuid
      `,
    );
    // A class material that was uploaded but never published (still scanning) does not count either.
    await asAdmin(
      g.schoolId,
      (tx) =>
        tx`
        INSERT INTO app.materials
          (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, storage_key,
           original_file_name, mime_type, size_bytes, ingest_status, created_at, updated_at)
        VALUES (${g.schoolId}::uuid, ${g.classes.a}::uuid, ${g.teacherUserIds.lead}::uuid,
                ${g.teacherUserIds.lead}::uuid, 'Pending', ${`permanent/${g.schoolId}/m/${crypto.randomUUID()}`},
                'pending.pdf', 'application/pdf', 1024, 'scanning',
                '2026-11-04T08:00:00Z', '2026-11-04T08:00:00Z')
      `,
    );
    await publish(g, g.classes.a, "2026-11-05T08:00:00Z");

    const report = await asAdmin(g.schoolId, (tx) => uploadConsistency(tx, FORTNIGHT));
    const algebra = report.classes.find((c) => c.classId === g.classes.a)!;
    expect(algebra).toMatchObject({ schoolDays: 10, uploadDays: 1, consistencyBps: 1000 });
  });

  integrationTest("per teacher: the mean of the classes they teach", async () => {
    const report = await asAdmin(f.schoolId, (tx) => uploadConsistency(tx, FORTNIGHT));
    const byTeacher = new Map(report.teachers.map((t) => [t.teacherId, t]));
    // Lead teacher: Algebra (lead) and Biology (approved timetable) -> (4444 + 10000) / 2.
    expect(byTeacher.get(f.teachers.lead)).toMatchObject({ consistencyBps: 7222 });
    expect(byTeacher.get(f.teachers.lead)!.classIds.sort()).toEqual(
      [f.classes.a, f.classes.b].sort(),
    );
    // Biology's lead.
    expect(byTeacher.get(f.teachers.coTeacher)).toMatchObject({
      classIds: [f.classes.b],
      consistencyBps: 10_000,
    });
    // The other teacher teaches no measured class (a draft timetable does not count).
    expect(byTeacher.has(f.teachers.other)).toBe(false);
    expect(report.classes.find((c) => c.classId === f.classes.a)!.teacherIds).toEqual([
      f.teachers.lead,
    ]);
  });

  integrationTest("any date range; days after today never count", async () => {
    // One week: Sun 8 to Sat 14 November has 5 school days, Algebra uploaded on none of them.
    const week = await asAdmin(f.schoolId, (tx) =>
      uploadConsistency(tx, { from: "2026-11-08", to: "2026-11-14" }),
    );
    expect(week.schoolDays).toBe(5);
    expect(week.classes.find((c) => c.classId === f.classes.a)).toMatchObject({
      schoolDays: 5,
      uploadDays: 0,
      consistencyBps: 0,
    });
    // One day: the holiday alone has no school day at all.
    const off = await asAdmin(f.schoolId, (tx) =>
      uploadConsistency(tx, { from: "2026-11-03", to: "2026-11-03" }),
    );
    expect(off.schoolDays).toBe(0);
    expect(off.classes.every((c) => c.consistencyBps === null)).toBe(true);
    expect(off.consistencyBps).toBeNull();

    // A range into the future stops at today (in Dubai).
    const [now] = await asAdmin(
      f.schoolId,
      (tx) =>
        tx<{ today: string; later: string }[]>`
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Dubai')::date::text AS today,
               ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Dubai')::date + 30)::text AS later
      `,
    );
    const ahead = await asAdmin(f.schoolId, (tx) =>
      uploadConsistency(tx, { from: "2026-11-01", to: now!.later }),
    );
    expect(ahead.today).toBe(now!.today);
    expect(ahead.countedTo).toBe(now!.today);
    expect(ahead.schoolDays).toBe(
      schoolDaysBetween(
        "2026-11-01",
        now!.today,
        [7, 1, 2, 3, 4],
        [{ startsOn: "2026-11-03", endsOn: "2026-11-03" }],
      ).length,
    );
  });

  integrationTest("the current period runs from the licence's start to today", async () => {
    const view = await asAdmin(f.schoolId, (tx) => uploadConsistencyView(tx, null));
    expect(view.basis).toBe("license");
    // The licence starts at 2026-08-31T20:00Z: midnight on 1 September in Dubai.
    expect(view.from).toBe("2026-09-01");
    expect(view.to).toBe(view.today);

    const requested = await asAdmin(f.schoolId, (tx) => uploadConsistencyView(tx, FORTNIGHT));
    expect(requested.basis).toBe("requested");
    expect(requested.consistencyBps).toBe(7222);
  });

  integrationTest("the bonus tier is read from the licence's own programme values", async () => {
    const view = await asAdmin(f.schoolId, (tx) => uploadConsistencyView(tx, FORTNIGHT));
    // Defaults: 0 -> 0, 60% -> +1.5%, 80% -> +3%. 72.22% is in the 60% tier.
    expect(view.bonus).toMatchObject({
      licenseId: f.licenseId,
      source: "license",
      tier: { fromBps: 6000, shareBps: 150 },
      nextTier: { fromBps: 8000, shareBps: 300 },
      targetBps: 6000,
    });

    // A school override with its own bonus table, signed onto the licence.
    const fields: SchoolOverrideInput = {
      licensePriceMinor: null,
      parentPriceMinor: null,
      minSeats: null,
      maxShareBps: null,
      conversionTiers: null,
      largeSchoolMinSeats: null,
      largeSchoolShareBps: null,
      contentBonusTiers: [
        { fromBps: 0, shareBps: 0 },
        { fromBps: 7000, shareBps: 200 },
      ],
      bonusRequiresConversionShare: null,
      measurementOffsetDays: null,
      nonpaymentGraceDays: null,
      monthToMonthShareBps: null,
      payoutMode: null,
      reason: "Lower bonus bar",
    };
    await runLicenseChange(deps(), f.schoolId, operator, async (tx) => {
      await saveSchoolOverride(tx, f.schoolId, fields, operator);
      return { result: null, versions: new Map(), pending: [] };
    });
    // Existing licence: still the values it was signed with.
    const kept = await asAdmin(f.schoolId, (tx) => uploadConsistencyView(tx, FORTNIGHT));
    expect(kept.bonus.tier).toEqual({ fromBps: 6000, shareBps: 150 });

    await asAdmin(
      f.schoolId,
      (tx) =>
        tx`
        UPDATE app.school_licenses
        SET ai_programme_override_id = (
          SELECT id FROM app.ai_programme_school_overrides
          WHERE school_id = ${f.schoolId}::uuid ORDER BY version_number DESC LIMIT 1)
        WHERE id = ${f.licenseId}::uuid
      `,
    );
    const moved = await asAdmin(f.schoolId, (tx) => uploadConsistencyView(tx, FORTNIGHT));
    expect(moved.bonus.tier).toEqual({ fromBps: 7000, shareBps: 200 });
    expect(moved.bonus.nextTier).toBeNull();

    // The direct read agrees with Phase 1's resolver.
    const license = await asAdmin(f.schoolId, (tx) => readLicense(tx, f.licenseId));
    const stamp = {
      versionId: license!.aiProgrammeVersionId,
      overrideId: license!.aiProgrammeOverrideId,
    };
    const [direct, resolved] = await asAdmin(f.schoolId, async (tx) => [
      await contentBonusTiersFor(tx, stamp),
      (await resolveAiProgrammeStamp(tx, stamp, "USD")).values.contentBonusTiers,
    ]);
    expect(direct).toEqual([...resolved]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------------------------------

describe("tenancy", () => {
  integrationTest(
    "a school's report holds only its own classes, under the runtime role",
    async () => {
      const one = await fixture("Tenant One");
      const two = await fixture("Tenant Two");
      await publish(one, one.classes.a, "2026-11-01T08:00:00Z");
      await publish(two, two.classes.a, "2026-11-02T08:00:00Z");
      await publish(two, two.classes.a, "2026-11-04T08:00:00Z");

      const mine = await asApp(one.schoolId, one.adminUserId, (tx) =>
        uploadConsistency(tx, FORTNIGHT),
      );
      const ownIds = Object.values(one.classes);
      const theirIds = Object.values(two.classes);
      expect(mine.classes.length).toBe(2);
      expect(mine.classes.every((c) => ownIds.includes(c.classId))).toBe(true);
      expect(mine.classes.some((c) => theirIds.includes(c.classId))).toBe(false);
      expect(mine.classes.find((c) => c.classId === one.classes.a)!.uploadDays).toBe(1);
      expect(mine.teachers.every((t) => Object.values(one.teachers).includes(t.teacherId))).toBe(
        true,
      );
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------

describe("routes", () => {
  let api: TestApp;
  let f: Fixture;

  beforeAll(async () => {
    if (!integrationEnabled) return;
    const created = createTestApp({ database: db.sql });
    await created.ready;
    api = created;
    f = await fixture("Routes School");
    await publish(f, f.classes.a, "2026-11-01T08:00:00Z");
  });

  const as = (schoolId: string, userId: string, role: Role, path: string) =>
    authenticatedRequest(api, "GET", path, {
      schoolId,
      userId,
      roles: [role],
      channel: AUTH_CHANNELS.WEB,
    });

  const SCHOOL = "/api/school/license/upload-consistency";

  integrationTest("the school's admin and principal read their own school", async () => {
    const res = await as(
      f.schoolId,
      f.adminUserId,
      ROLES.ORG_ADMIN,
      `${SCHOOL}?from=2026-11-01&to=2026-11-14`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      basis: string;
      schoolDays: number;
      classes: { classId: string; uploadDays: number }[];
      bonus: { licenseId: string };
    };
    expect(body.basis).toBe("requested");
    expect(body.schoolDays).toBe(10);
    expect(body.classes.find((c) => c.classId === f.classes.a)!.uploadDays).toBe(1);
    expect(body.bonus.licenseId).toBe(f.licenseId);

    const principal = await createUser(db.sql, f.schoolId);
    await assignRole(db.sql, f.schoolId, principal.id, ROLES.PRINCIPAL);
    const current = await as(f.schoolId, principal.id, ROLES.PRINCIPAL, SCHOOL);
    expect(current.status).toBe(200);
    expect(((await current.json()) as { basis: string }).basis).toBe("license");

    // A teacher holds no license:read.
    const teacher = await as(f.schoolId, f.teacherUserIds.lead, ROLES.INSTRUCTOR, SCHOOL);
    expect(teacher.status).toBe(403);
  });

  integrationTest("a bad period is refused", async () => {
    for (const query of [
      "?from=2026-11-01",
      "?from=2026-11-14&to=2026-11-01",
      "?from=2025-01-01&to=2026-11-01",
      "?from=2026-02-30&to=2026-03-01",
    ]) {
      const res = await as(f.schoolId, f.adminUserId, ROLES.ORG_ADMIN, `${SCHOOL}${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }
  });

  integrationTest("the super admin reads any school; a school admin cannot", async () => {
    const path = `/api/platform/schools/${f.schoolId}/ai-programme/upload-consistency?from=2026-11-01&to=2026-11-14`;
    const res = await as(hq, operator.userId, ROLES.SUPER_ADMIN, path);
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { classes: { classId: string }[] }).classes.map((c) => c.classId),
    ).toContain(f.classes.a);

    const missing = await as(
      hq,
      operator.userId,
      ROLES.SUPER_ADMIN,
      `/api/platform/schools/${crypto.randomUUID()}/ai-programme/upload-consistency`,
    );
    expect(missing.status).toBe(404);

    const denied = await as(f.schoolId, f.adminUserId, ROLES.ORG_ADMIN, path);
    expect(denied.status).toBe(403);

    // The school route answers for the caller's own school only: another school's admin gets theirs.
    const other = await fixture("Other Routes School");
    const theirs = await as(
      other.schoolId,
      other.adminUserId,
      ROLES.ORG_ADMIN,
      `${SCHOOL}?from=2026-11-01&to=2026-11-14`,
    );
    const ids = ((await theirs.json()) as { classes: { classId: string }[] }).classes.map(
      (c) => c.classId,
    );
    expect(ids).not.toContain(f.classes.a);
    expect(ids).toContain(other.classes.a);
  });
});
