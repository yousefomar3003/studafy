// ST-085 intra-tenant row scope: teacher / parent / student SELECT visibility.
//
// One school, two classes with distinct lead teachers, two students in class A (to prove enrollment
// privacy between classmates), one in class B, and a parent linked to student A. Every academic table
// is seeded, then read back under each principal's tenant transaction to assert the role_scope_visibility
// policies expose exactly the rows that principal may see -- and no more.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTransaction } from "../../src/database";
import {
  createTestDatabase,
  migrateDatabase,
  integrationEnabled,
  createSchool,
  createUser,
  assignRole,
  createStudent,
  createTeacher,
  createAcademicYear,
  createTerm,
  createSubject,
  createCourse,
  createRoom,
  createClass,
  createEnrollment,
  createMaterial,
  type TestDatabase,
} from "../harness";

import { inspectPlan } from "./probe-support";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const JULY = "2026-07-15 12:00:00+00";
const JULY_END = "2026-07-15 14:00:00+00";
const SNAPSHOT_BUDGET_MS = 1000;

// Every table that receives a role_scope_visibility policy; used by the index-plan assertion.
const SCOPED_TABLES = [
  "students",
  "enrollments",
  "classes",
  "subjects",
  "courses",
  "materials",
  "assignments",
  "exams",
  "gradebooks",
  "timetable_slots",
  "assignment_submissions",
  "exam_results",
  "grade_submissions",
  "grades",
  "attendance_sessions",
  "attendance_records",
] as const;

interface Fixture {
  schoolId: string;
  adminUserId: string;
  guestUserId: string;
  teacherAUserId: string;
  teacherBUserId: string;
  studentAUserId: string;
  studentA2UserId: string;
  studentBUserId: string;
  parentUserId: string;
  classAId: string;
  classBId: string;
  studentAId: string;
  studentA2Id: string;
  studentBId: string;
  subjectAId: string;
  subjectBId: string;
  materialAId: string;
  materialBId: string;
  publishedSubmissionId: string;
  draftSubmissionId: string;
  gradeId: string;
  publishedExamResultId: string;
  withheldExamResultId: string;
  submissionAId: string;
}

interface Snapshot {
  students: string[];
  classes: string[];
  materials: string[];
  enrollments: string[];
  gradeSubmissions: string[];
  grades: string[];
  examResults: string[];
  assignmentSubmissions: string[];
  attendanceRecords: string[];
  subjects: string[];
  timetableSlots: string[];
}

let db: TestDatabase | undefined;
let fixture: Fixture | undefined;

async function asAppUser<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(db!.sql, { schoolId, userId }, fn);
}

/** Column of ids from a scoped read, sorted for stable comparison. */
async function ids(tx: TransactionSql, query: string): Promise<string[]> {
  const rows = await tx.unsafe<{ id: string }[]>(query);
  return rows.map((row) => row.id).sort();
}

async function snapshotFor(userId: string): Promise<Snapshot> {
  return asAppUser(fixture!.schoolId, userId, async (tx) => ({
    students: await ids(tx, "SELECT id FROM app.students"),
    classes: await ids(tx, "SELECT id FROM app.classes"),
    materials: await ids(tx, "SELECT id FROM app.materials"),
    enrollments: await ids(tx, "SELECT student_id AS id FROM app.enrollments"),
    gradeSubmissions: await ids(tx, "SELECT id FROM app.grade_submissions"),
    grades: await ids(tx, "SELECT id FROM app.grades"),
    examResults: await ids(tx, "SELECT id FROM app.exam_results"),
    assignmentSubmissions: await ids(tx, "SELECT id FROM app.assignment_submissions"),
    attendanceRecords: await ids(tx, "SELECT student_id AS id FROM app.attendance_records"),
    subjects: await ids(tx, "SELECT id FROM app.subjects"),
    timetableSlots: await ids(tx, "SELECT id FROM app.timetable_slots"),
  }));
}

async function seed(): Promise<Fixture> {
  const sql = db!.sql;
  const school = await createSchool(sql);
  const schoolId = school.id;

  const admin = await createUser(sql, schoolId, { email: `admin@${school.slug}.local` });
  await assignRole(sql, schoolId, admin.id, "ORG_ADMIN");
  const guest = await createUser(sql, schoolId, { email: `guest@${school.slug}.local` });
  await assignRole(sql, schoolId, guest.id, "GUEST");

  const teacherA = await createTeacher(sql, schoolId, { email: `ta@${school.slug}.local` });
  await assignRole(sql, schoolId, teacherA.userId, "INSTRUCTOR");
  const teacherB = await createTeacher(sql, schoolId, { email: `tb@${school.slug}.local` });
  await assignRole(sql, schoolId, teacherB.userId, "INSTRUCTOR");

  const studentA = await createStudent(sql, schoolId, { email: `sa@${school.slug}.local` });
  await assignRole(sql, schoolId, studentA.userId, "STUDENT");
  const studentA2 = await createStudent(sql, schoolId, { email: `sa2@${school.slug}.local` });
  await assignRole(sql, schoolId, studentA2.userId, "STUDENT");
  const studentB = await createStudent(sql, schoolId, { email: `sb@${school.slug}.local` });
  await assignRole(sql, schoolId, studentB.userId, "STUDENT");

  const parent = await createUser(sql, schoolId, { email: `parent@${school.slug}.local` });
  // Parents hold no enum role; the link alone confers scope.

  const year = await createAcademicYear(sql, schoolId);
  const term = await createTerm(sql, schoolId, year.id);
  const room = await createRoom(sql, schoolId);
  const subjectA = await createSubject(sql, schoolId, { code: `SUBA-${school.slug}` });
  const courseA = await createCourse(sql, schoolId, subjectA.id, { code: `CRA-${school.slug}` });
  const subjectB = await createSubject(sql, schoolId, { code: `SUBB-${school.slug}` });
  const courseB = await createCourse(sql, schoolId, subjectB.id, { code: `CRB-${school.slug}` });

  const classA = await createClass(sql, schoolId, {
    courseId: courseA.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacherA.id,
    roomId: room.id,
    code: `CA-${school.slug}`,
  });
  const classB = await createClass(sql, schoolId, {
    courseId: courseB.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacherB.id,
    roomId: room.id,
    code: `CB-${school.slug}`,
  });

  await createEnrollment(sql, schoolId, classA.id, studentA.id);
  await createEnrollment(sql, schoolId, classA.id, studentA2.id);
  await createEnrollment(sql, schoolId, classB.id, studentB.id);

  const materialA = await createMaterial(sql, schoolId, {
    classId: classA.id,
    uploadedByUserId: teacherA.userId,
  });
  const materialB = await createMaterial(sql, schoolId, {
    classId: classB.id,
    uploadedByUserId: teacherB.userId,
  });

  // Everything below has no factory; seed it directly under the tenant transaction.
  const extra = await asAppUser(schoolId, admin.id, async (tx) => {
    await tx`
      INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship)
      VALUES (${schoolId}, ${parent.id}, ${studentA.id}, 'mother')
    `;

    // Timetable version (draft) + one slot for class A taught by teacher A.
    const [version] = await tx<{ id: string }[]>`
      INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name)
      VALUES (${schoolId}, ${year.id}, ${term.id}, 'ST-085 Draft') RETURNING id
    `;
    await tx`
      INSERT INTO app.timetable_slots
        (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
      VALUES (${schoolId}, ${version!.id}, ${classA.id}, ${teacherA.id}, ${room.id}, 1, 1)
    `;

    // Assignment + student A's submission.
    const [assignment] = await tx<{ id: string }[]>`
      INSERT INTO app.assignments
        (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, status,
         assigned_at, due_at, max_score)
      VALUES (${schoolId}, ${classA.id}, ${teacherA.userId}, ${teacherA.userId}, 'Essay',
        'published', ${JULY}::timestamptz, ${JULY}::timestamptz, 100) RETURNING id
    `;
    const [submissionA] = await tx<{ id: string }[]>`
      INSERT INTO app.assignment_submissions
        (school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at)
      VALUES (${schoolId}, ${assignment!.id}, ${studentA.id}, ${studentA.userId}, 'submitted',
        ${JULY}::timestamptz) RETURNING id
    `;

    // Exam + a published and a withheld result for student A.
    const [exam] = await tx<{ id: string }[]>`
      INSERT INTO app.exams
        (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, status,
         starts_at, ends_at, max_score)
      VALUES (${schoolId}, ${classA.id}, ${teacherA.userId}, ${teacherA.userId}, 'Midterm',
        'closed', ${JULY}::timestamptz, ${JULY_END}::timestamptz, 100) RETURNING id
    `;
    const [publishedResult] = await tx<{ id: string }[]>`
      INSERT INTO app.exam_results
        (school_id, exam_id, student_id, last_edited_by_user_id, graded_by_user_id,
         published_by_user_id, status, score, graded_at, published_at)
      VALUES (${schoolId}, ${exam!.id}, ${studentA.id}, ${teacherA.userId}, ${teacherA.userId},
        ${teacherA.userId}, 'published', 88, ${JULY}::timestamptz, ${JULY}::timestamptz)
      RETURNING id
    `;
    const [withheldResult] = await tx<{ id: string }[]>`
      INSERT INTO app.exam_results
        (school_id, exam_id, student_id, last_edited_by_user_id, graded_by_user_id, status,
         score, graded_at)
      VALUES (${schoolId}, ${exam!.id}, ${studentA2.id}, ${teacherA.userId}, ${teacherA.userId},
        'withheld', 40, ${JULY}::timestamptz) RETURNING id
    `;

    // Gradebook + a published submission (walked through the state machine) with one grade, and a
    // draft submission that student A must NOT see.
    const [gradebook] = await tx<{ id: string }[]>`
      INSERT INTO app.gradebooks (school_id, class_id, status)
      VALUES (${schoolId}, ${classA.id}, 'active') RETURNING id
    `;
    const [published] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id, status)
      VALUES (${schoolId}, ${gradebook!.id}, ${studentA.id}, 'draft') RETURNING id
    `;
    await tx`
      UPDATE app.grade_submissions SET status = 'submitted', submitted_by_user_id = ${teacherA.userId}
      WHERE id = ${published!.id}
    `;
    await tx`
      UPDATE app.grade_submissions SET status = 'approved', decided_by_user_id = ${teacherA.userId}
      WHERE id = ${published!.id}
    `;
    await tx`
      UPDATE app.grade_submissions SET status = 'published' WHERE id = ${published!.id}
    `;
    const [grade] = await tx<{ id: string }[]>`
      INSERT INTO app.grades (school_id, grade_submission_id, max_score, weight, label, score)
      VALUES (${schoolId}, ${published!.id}, 100, 1, 'Homework 1', 92) RETURNING id
    `;
    const [draft] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id, status)
      VALUES (${schoolId}, ${gradebook!.id}, ${studentA2.id}, 'draft') RETURNING id
    `;

    // Attendance for class A: one session, records for both class-A students.
    const [session] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO app.attendance_sessions
        (school_id, class_id, session_date, status, taken_by_user_id, created_at, updated_at)
      VALUES (${schoolId}, ${classA.id}, '2026-07-15', 'open', ${teacherA.userId},
        ${JULY}::timestamptz, ${JULY}::timestamptz) RETURNING id, created_at
    `;
    await tx`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status,
         recorded_by_user_id, created_at, updated_at)
      VALUES (${schoolId}, ${session!.id}, ${session!.created_at}, ${studentA.id}, 'present',
        ${teacherA.userId}, ${JULY}::timestamptz, ${JULY}::timestamptz)
    `;
    await tx`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status,
         recorded_by_user_id, created_at, updated_at)
      VALUES (${schoolId}, ${session!.id}, ${session!.created_at}, ${studentA2.id}, 'present',
        ${teacherA.userId}, ${JULY}::timestamptz, ${JULY}::timestamptz)
    `;

    return {
      publishedSubmissionId: published!.id,
      draftSubmissionId: draft!.id,
      gradeId: grade!.id,
      publishedExamResultId: publishedResult!.id,
      withheldExamResultId: withheldResult!.id,
      submissionAId: submissionA!.id,
    };
  });

  await sql.unsafe("ANALYZE");

  return {
    schoolId,
    adminUserId: admin.id,
    guestUserId: guest.id,
    teacherAUserId: teacherA.userId,
    teacherBUserId: teacherB.userId,
    studentAUserId: studentA.userId,
    studentA2UserId: studentA2.userId,
    studentBUserId: studentB.userId,
    parentUserId: parent.id,
    classAId: classA.id,
    classBId: classB.id,
    studentAId: studentA.id,
    studentA2Id: studentA2.id,
    studentBId: studentB.id,
    subjectAId: subjectA.id,
    subjectBId: subjectB.id,
    materialAId: materialA.id,
    materialBId: materialB.id,
    ...extra,
  };
}

describe("ST-085 row-scope visibility", () => {
  beforeAll(async () => {
    if (!integrationEnabled) return;
    db = await createTestDatabase();
    await migrateDatabase(db.url);
    fixture = await seed();
  }, 90_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  integrationTest("admin sees every academic row in the school", async () => {
    const f = fixture!;
    const snap = await snapshotFor(f.adminUserId);
    expect(snap.students.sort()).toEqual([f.studentAId, f.studentA2Id, f.studentBId].sort());
    expect(snap.classes.sort()).toEqual([f.classAId, f.classBId].sort());
    expect(snap.materials.sort()).toEqual([f.materialAId, f.materialBId].sort());
    expect(snap.gradeSubmissions.sort()).toEqual(
      [f.publishedSubmissionId, f.draftSubmissionId].sort(),
    );
    expect(snap.examResults.sort()).toEqual(
      [f.publishedExamResultId, f.withheldExamResultId].sort(),
    );
    expect(snap.subjects.sort()).toEqual([f.subjectAId, f.subjectBId].sort());
  });

  integrationTest("teacher A sees only class A; teacher B only class B", async () => {
    const f = fixture!;
    const a = await snapshotFor(f.teacherAUserId);
    expect(a.students.sort()).toEqual([f.studentAId, f.studentA2Id].sort());
    expect(a.classes).toEqual([f.classAId]);
    expect(a.materials).toEqual([f.materialAId]);
    expect(a.subjects).toEqual([f.subjectAId]);
    // A teacher sees every grade submission for their class, in any workflow status.
    expect(a.gradeSubmissions.sort()).toEqual(
      [f.publishedSubmissionId, f.draftSubmissionId].sort(),
    );
    expect(a.examResults.sort()).toEqual([f.publishedExamResultId, f.withheldExamResultId].sort());
    // Teacher A holds the one timetable slot; both class-A attendance records are visible.
    expect(a.timetableSlots).toHaveLength(1);
    expect(a.attendanceRecords.sort()).toEqual([f.studentAId, f.studentA2Id].sort());

    const b = await snapshotFor(f.teacherBUserId);
    expect(b.students).toEqual([f.studentBId]);
    expect(b.classes).toEqual([f.classBId]);
    expect(b.materials).toEqual([f.materialBId]);
    expect(b.gradeSubmissions).toEqual([]);
    expect(b.examResults).toEqual([]);
    expect(b.timetableSlots).toEqual([]);
    expect(b.attendanceRecords).toEqual([]);
  });

  integrationTest("student A sees only self, released grades, and own enrollment", async () => {
    const f = fixture!;
    const snap = await snapshotFor(f.studentAUserId);
    expect(snap.students).toEqual([f.studentAId]);
    expect(snap.classes).toEqual([f.classAId]);
    expect(snap.materials).toEqual([f.materialAId]);
    // Own enrollment only -- not classmate student A2's, even in the same class.
    expect(snap.enrollments).toEqual([f.studentAId]);
    // Published grade submission is visible; the draft (for A2) is not; A2's row is not.
    expect(snap.gradeSubmissions).toEqual([f.publishedSubmissionId]);
    expect(snap.grades).toEqual([f.gradeId]);
    // Published exam result only -- the withheld one (A2's) is hidden.
    expect(snap.examResults).toEqual([f.publishedExamResultId]);
    expect(snap.assignmentSubmissions).toEqual([f.submissionAId]);
    // Own attendance only.
    expect(snap.attendanceRecords).toEqual([f.studentAId]);
  });

  integrationTest("draft grades stay hidden from the student who owns them", async () => {
    const f = fixture!;
    // Student A2 owns the draft submission but must not see it until it is published.
    const snap = await snapshotFor(f.studentA2UserId);
    expect(snap.gradeSubmissions).toEqual([]);
    expect(snap.grades).toEqual([]);
    // A2's exam result is withheld, so also hidden from A2.
    expect(snap.examResults).toEqual([]);
    expect(snap.students).toEqual([f.studentA2Id]);
  });

  integrationTest("parent sees only the linked child's released records", async () => {
    const f = fixture!;
    const snap = await snapshotFor(f.parentUserId);
    expect(snap.students).toEqual([f.studentAId]);
    expect(snap.classes).toEqual([f.classAId]);
    expect(snap.gradeSubmissions).toEqual([f.publishedSubmissionId]);
    expect(snap.grades).toEqual([f.gradeId]);
    expect(snap.examResults).toEqual([f.publishedExamResultId]);
    expect(snap.attendanceRecords).toEqual([f.studentAId]);
  });

  integrationTest("a roleless / guest user sees no academic rows", async () => {
    const f = fixture!;
    const snap = await snapshotFor(f.guestUserId);
    expect(snap.students).toEqual([]);
    expect(snap.classes).toEqual([]);
    expect(snap.materials).toEqual([]);
    expect(snap.gradeSubmissions).toEqual([]);
    expect(snap.examResults).toEqual([]);
    expect(snap.attendanceRecords).toEqual([]);
  });

  integrationTest(
    "scoped reads stay index-backed and within the timing budget",
    async () => {
      const f = fixture!;

      // Every scoped table must resolve via an index (school-leading) even with seq scans penalized;
      // the SECURITY DEFINER predicate is an opaque filter and must not force a scan of the outer table.
      await asAppUser(f.schoolId, f.teacherAUserId, async (tx) => {
        await tx.unsafe("SET LOCAL enable_seqscan = off");
        for (const table of SCOPED_TABLES) {
          const plan = await tx.unsafe<
            { "QUERY PLAN": [{ Plan: Parameters<typeof inspectPlan>[0] }] }[]
          >(`EXPLAIN (FORMAT JSON) SELECT 1 FROM app.${table} LIMIT 1`);
          const root = plan[0]?.["QUERY PLAN"]?.[0]?.Plan;
          if (!root) throw new Error(`EXPLAIN returned no plan for app.${table}`);
          const inspection = inspectPlan(root);
          expect(inspection.sequentialRelations, `seq scan planned for app.${table}`).toEqual([]);
          expect(
            inspection.nodeTypes.some((type) =>
              ["Index Scan", "Index Only Scan", "Bitmap Index Scan"].includes(type),
            ),
            `no index scan planned for app.${table}`,
          ).toBe(true);
        }
      });

      // Warm caches and plans, then time a full snapshot battery as a teacher (the widest scope).
      await snapshotFor(f.teacherAUserId);
      const started = performance.now();
      await snapshotFor(f.teacherAUserId);
      const elapsedMs = performance.now() - started;
      expect(elapsedMs, `warmed row-scope snapshot took ${elapsedMs.toFixed(2)}ms`).toBeLessThan(
        SNAPSHOT_BUDGET_MS,
      );
    },
    90_000,
  );
});
