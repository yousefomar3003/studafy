/**
 * Submission scope, lateness, resubmission, privacy, and audit tests (ST-104).
 *
 * Integration tests requiring a live PostgreSQL instance, in the style of
 * modules/academics/assignments/__tests__/assignments.test.ts. They are the only tests that can
 * demonstrate most of what this ticket is about: the atomicity of resubmission is a property of a
 * unique index, cross-student privacy is an RLS policy, and lateness is computed by the database
 * clock. None of the three exists outside a database.
 *
 * The COLUMN half of the privacy rule -- an unreleased grade withheld from a row the caller can
 * legitimately see -- is proved separately and without a database in grade-visibility.test.ts, so
 * that the most security-relevant assertion in the module is not one that silently skips.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/academics/submissions/__tests__
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createAcademicYear,
  createClass,
  createCourse,
  createEnrollment,
  createRoom,
  createSchool,
  createStudent,
  createSubject,
  createTeacher,
  createTerm,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../../tests/harness";
import { toSubmissionResponse } from "../routes/submission-routes";
import {
  getSubmission,
  gradeSubmission,
  isStaffForAssignment,
  listSubmissions,
  resolveCallerStudentId,
  submitAssignment,
} from "../submission-service";

import type { Sql, TransactionSql } from "postgres";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run inside a tenant transaction acting as a specific user.
 *
 * The GUCs are the whole point. app.school_id drives tenant_isolation; app.user_id drives
 * app.scope_user_id(), which every role-scope helper resolves the caller through. Running as
 * studafy_app rather than studafy_admin is equally load-bearing: the restrictive policies are
 * declared TO studafy_app and simply do not apply to the owner, so a test that forgot this would
 * pass while exercising no isolation at all.
 */
async function asUser<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    result = await fn(tx);
  });
  return result as T;
}

/** Read past every policy, to assert what is actually stored rather than what is projected. */
async function asOwner<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

function isoOffsetDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Seed an assignment directly, as studafy_admin.
 *
 * Deliberately not routed through the assignments service: these tests are about submissions, and
 * an assignment created with an already-past due_at (which is what the lateness cases need) is not
 * something that service will produce.
 */
async function seedAssignment(
  sql: Sql,
  schoolId: string,
  classId: string,
  teacherUserId: string,
  overrides: { dueAt?: string; allowLate?: boolean; status?: string; availableFrom?: string } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO app.assignments (
      school_id, class_id, created_by_user_id, last_edited_by_user_id,
      title, status, assigned_at, available_from, due_at, max_score, allow_late_submission
    ) VALUES (
      ${schoolId}, ${classId}, ${teacherUserId}, ${teacherUserId},
      'Problem Set 1',
      ${overrides.status ?? "published"}::app.assignment_status,
      CURRENT_TIMESTAMP - interval '1 day',
      ${overrides.availableFrom ?? null}::timestamptz,
      ${overrides.dueAt ?? isoOffsetDays(7)}::timestamptz,
      100,
      ${overrides.allowLate ?? false}
    )
    RETURNING id
  `;
  return row!.id;
}

/**
 * A school with two teachers, two classes, two students enrolled in class A, and a parent linked
 * to the first student.
 *
 * Two students in the SAME class is the shape that matters: classmate privacy is the case a
 * per-class policy would wave through, so a fixture with one student per class could not detect a
 * regression in it.
 */
async function seedTenant(sql: Sql) {
  const school = await createSchool(sql);
  const teacherA = await createTeacher(sql, school.id);
  const teacherB = await createTeacher(sql, school.id);
  const year = await createAcademicYear(sql, school.id);
  const term = await createTerm(sql, school.id, year.id);
  const subject = await createSubject(sql, school.id);
  const otherSubject = await createSubject(sql, school.id);
  const course = await createCourse(sql, school.id, subject.id);
  const otherCourse = await createCourse(sql, school.id, otherSubject.id);
  const room = await createRoom(sql, school.id);

  const classA = await createClass(sql, school.id, {
    courseId: course.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacherA.id,
    roomId: room.id,
  });
  const classB = await createClass(sql, school.id, {
    courseId: otherCourse.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacherB.id,
    roomId: room.id,
  });

  const studentA = await createStudent(sql, school.id);
  const studentB = await createStudent(sql, school.id);
  await createEnrollment(sql, school.id, classA.id, studentA.id);
  await createEnrollment(sql, school.id, classA.id, studentB.id);

  // A linked parent, and an unlinked one in the same school as the control.
  const parent = await createUser(sql, school.id);
  const strangerParent = await createUser(sql, school.id);
  const [family] = await sql<{ id: string }[]>`
    INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
    VALUES (${school.id}, 'Submission fixture family', ${parent.id})
    RETURNING id
  `;
  await sql`
    INSERT INTO app.parent_child_links
      (school_id, family_id, parent_user_id, student_id, relationship)
    VALUES (${school.id}, ${family!.id}, ${parent.id}, ${studentA.id}, 'mother')
  `;

  return {
    school,
    teacherA,
    teacherB,
    classA,
    classB,
    studentA,
    studentB,
    parent,
    strangerParent,
  };
}

/** Seed a tenant with one published assignment on class A, due in the future. */
async function seedWithAssignment(
  overrides: Parameters<typeof seedAssignment>[4] = {},
): Promise<Awaited<ReturnType<typeof seedTenant>> & { assignmentId: string }> {
  const t = await seedTenant(db.sql);
  const assignmentId = await seedAssignment(
    db.sql,
    t.school.id,
    t.classA.id,
    t.teacherA.userId,
    overrides,
  );
  return { ...t, assignmentId };
}

/** Hand work in as a student, resolving their student id the way the route does. */
async function submitAs(
  schoolId: string,
  userId: string,
  assignmentId: string,
  content = "My answer.",
) {
  return asUser(schoolId, userId, async (tx) => {
    const studentId = await resolveCallerStudentId(tx, schoolId);
    return submitAssignment(tx, schoolId, userId, studentId!, assignmentId, { content });
  });
}

async function countSubmissions(schoolId: string, assignmentId: string): Promise<number> {
  return asOwner(schoolId, async (tx) => {
    const [row] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.assignment_submissions
      WHERE school_id = ${schoolId} AND assignment_id = ${assignmentId}
    `;
    return Number(row!.n);
  });
}

// ---------------------------------------------------------------------------
// Late flagging
// ---------------------------------------------------------------------------

describeDb("late flagging", () => {
  test("work handed in before the deadline is not late", async () => {
    const t = await seedWithAssignment({ dueAt: isoOffsetDays(7) });

    const { row, created } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    expect(created).toBe(true);
    expect(row.is_late).toBe(false);
    expect(row.status).toBe("submitted");
    expect(row.attempt_number).toBe(1);
  });

  test("work handed in after the deadline is flagged late when the assignment allows it", async () => {
    // due_at is seeded in the past rather than the clock being manipulated, so the assertion never
    // depends on Date.now() and lateness is decided by the same clock the constraint uses.
    const t = await seedWithAssignment({ dueAt: isoOffsetDays(-1), allowLate: true });

    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    expect(row.is_late).toBe(true);
    // 'submitted', NOT 'late'. The enum value is vestigial -- 000011 made it mutually exclusive
    // with 'graded', which is what erased lateness on marking.
    expect(row.status).toBe("submitted");
  });

  test("a late hand-in is refused when the assignment forbids it, and writes nothing", async () => {
    const t = await seedWithAssignment({ dueAt: isoOffsetDays(-1), allowLate: false });

    await expect(submitAs(t.school.id, t.studentA.userId, t.assignmentId)).rejects.toThrow(
      /deadline has passed/i,
    );

    // The gates are predicates on the write itself, so a refusal cannot leave a partial row.
    expect(await countSubmissions(t.school.id, t.assignmentId)).toBe(0);
  });

  test("a hand-in before available_from is refused", async () => {
    const t = await seedWithAssignment({
      availableFrom: isoOffsetDays(1),
      dueAt: isoOffsetDays(7),
    });

    await expect(submitAs(t.school.id, t.studentA.userId, t.assignmentId)).rejects.toThrow(
      /not open for submissions yet/i,
    );
  });

  test("a draft assignment answers 404, not a window error", async () => {
    // A window-closed error would confirm the assignment exists. A student must not be able to
    // tell "your teacher has not published this yet" from "no such assignment".
    const t = await seedWithAssignment({ status: "draft" });

    await expect(submitAs(t.school.id, t.studentA.userId, t.assignmentId)).rejects.toThrow(
      /Assignment not found/i,
    );
  });

  test("lateness survives grading", async () => {
    // The regression 000049 exists to prevent: under 000011, marking a 'late' row moved it to
    // 'graded' and the lateness was gone.
    const t = await seedWithAssignment({ dueAt: isoOffsetDays(-1), allowLate: true });
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const graded = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 80,
        publish: true,
        return_to_student: false,
      }),
    );

    expect(graded.status).toBe("graded");
    expect(graded.is_late).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resubmission
// ---------------------------------------------------------------------------

describeDb("resubmission", () => {
  test("resubmitting replaces the row in place and increments the attempt", async () => {
    const t = await seedWithAssignment();

    const first = await submitAs(t.school.id, t.studentA.userId, t.assignmentId, "First draft.");
    const second = await submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Second draft.");

    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.attempt_number).toBe(2);
    expect(second.row.content).toBe("Second draft.");
    expect(await countSubmissions(t.school.id, t.assignmentId)).toBe(1);
  });

  test("two concurrent hand-ins produce one row and exactly one increment", async () => {
    // The test the ON CONFLICT design exists for. Two SEPARATE transactions on two connections --
    // sharing one would serialize them trivially and prove nothing. A read-then-write
    // implementation loses an increment here; ON CONFLICT DO UPDATE reads attempt_number under the
    // row lock conflict resolution already holds.
    const t = await seedWithAssignment();
    await submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Initial.");

    await Promise.all([
      submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Race A."),
      submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Race B."),
    ]);

    expect(await countSubmissions(t.school.id, t.assignmentId)).toBe(1);

    const attempt = await asOwner(t.school.id, async (tx) => {
      const [row] = await tx<{ attempt_number: number }[]>`
        SELECT attempt_number FROM app.assignment_submissions
        WHERE school_id = ${t.school.id} AND assignment_id = ${t.assignmentId}
      `;
      return row!.attempt_number;
    });

    expect(attempt).toBe(3);
  });

  test("resubmitting clears an unpublished mark", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 40,
        feedback: "Needs work.",
        publish: false,
        return_to_student: false,
      }),
    );

    const resubmitted = await submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Redone.");

    // A new attempt invalidates the mark on the old one.
    expect(resubmitted.row.grade_status).toBe("none");
    expect(resubmitted.row.score).toBeNull();
    expect(resubmitted.row.feedback).toBeNull();
    expect(resubmitted.row.graded_at).toBeNull();
    expect(resubmitted.row.graded_by_user_id).toBeNull();
  });

  test("resubmitting re-evaluates lateness", async () => {
    const t = await seedWithAssignment({ dueAt: isoOffsetDays(1), allowLate: true });
    const first = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);
    expect(first.row.is_late).toBe(false);

    // Move the deadline into the past, then resubmit.
    await db.sql`
      UPDATE app.assignments SET due_at = CURRENT_TIMESTAMP - interval '1 hour'
      WHERE id = ${t.assignmentId} AND school_id = ${t.school.id}
    `;

    const second = await submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Late redo.");
    expect(second.row.is_late).toBe(true);
  });

  test("resubmitting over a published grade is refused", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 90,
        publish: true,
        return_to_student: false,
      }),
    );

    await expect(
      submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Sneaky redo."),
    ).rejects.toThrow(/already been graded/i);
  });

  test("resubmitting is permitted once the teacher returns the work", async () => {
    const t = await seedWithAssignment({ dueAt: isoOffsetDays(-1), allowLate: true });
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 30,
        publish: true,
        return_to_student: false,
      }),
    );
    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        publish: false,
        return_to_student: true,
      }),
    );

    const redo = await submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Improved.");
    expect(redo.row.attempt_number).toBe(2);
    expect(redo.row.grade_status).toBe("none");
  });

  test("only the first hand-in announces submission.created", async () => {
    const t = await seedWithAssignment();
    await submitAs(t.school.id, t.studentA.userId, t.assignmentId);
    await submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Again.");

    const events = await asOwner(t.school.id, async (tx) => {
      const [row] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM app.outbox_events
        WHERE school_id = ${t.school.id} AND event_name = 'submission.created'
      `;
      return Number(row!.n);
    });

    expect(events).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-student isolation
// ---------------------------------------------------------------------------

describeDb("cross-student isolation", () => {
  test("a classmate cannot read another student's submission", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const seen = await asUser(t.school.id, t.studentB.userId, (tx) =>
      getSubmission(tx, t.school.id, row.id),
    );

    expect(seen).toBeNull();
  });

  test("a student's list contains only their own work", async () => {
    const t = await seedWithAssignment();
    await submitAs(t.school.id, t.studentA.userId, t.assignmentId);
    await submitAs(t.school.id, t.studentB.userId, t.assignmentId);

    const page = await asUser(t.school.id, t.studentB.userId, async (tx) => {
      const studentId = await resolveCallerStudentId(tx, t.school.id);
      return listSubmissions(
        tx,
        t.school.id,
        t.assignmentId,
        { limit: 50, offset: 0 },
        false,
        studentId,
      );
    });

    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.student_id).toBe(t.studentB.id);
  });

  test("the class teacher sees every submission", async () => {
    const t = await seedWithAssignment();
    await submitAs(t.school.id, t.studentA.userId, t.assignmentId);
    await submitAs(t.school.id, t.studentB.userId, t.assignmentId);

    const page = await asUser(t.school.id, t.teacherA.userId, async (tx) => {
      expect(await isStaffForAssignment(tx, t.assignmentId)).toBe(true);
      return listSubmissions(tx, t.school.id, t.assignmentId, { limit: 50, offset: 0 }, true, null);
    });

    expect(page.total).toBe(2);
  });

  test("a teacher who does not teach the class cannot grade", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await expect(
      asUser(t.school.id, t.teacherB.userId, (tx) =>
        gradeSubmission(tx, t.school.id, t.teacherB.userId, row.id, {
          score: 100,
          publish: true,
          return_to_student: false,
        }),
      ),
    ).rejects.toThrow(/do not teach|not found/i);
  });
});

// ---------------------------------------------------------------------------
// Unpublished grades
// ---------------------------------------------------------------------------

describeDb("unpublished grade visibility", () => {
  test("a draft mark is withheld from the student but stored in full", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 87.5,
        feedback: "Check your units.",
        publish: false,
        return_to_student: false,
      }),
    );

    // What the student is served.
    const studentView = await asUser(t.school.id, t.studentA.userId, async (tx) => {
      const stored = await getSubmission(tx, t.school.id, row.id);
      return toSubmissionResponse(stored!, [], false);
    });

    expect(studentView.score).toBeNull();
    expect(studentView.feedback).toBeNull();
    expect(studentView.graded_at).toBeNull();
    expect(studentView.graded_by_user_id).toBeNull();
    expect(studentView.grade_status).toBe("none");
    // The lifecycle field the student already watches has not moved -- which is what makes the
    // withholding invisible rather than merely incomplete.
    expect(studentView.status).toBe("submitted");

    // What is actually on disk. The withholding is a projection, not a deletion: the teacher's
    // work is preserved and simply not served.
    const stored = await asOwner(t.school.id, async (tx) => {
      const [r] = await tx<{ score: string; feedback: string; grade_status: string }[]>`
        SELECT score::text, feedback, grade_status::text
        FROM app.assignment_submissions WHERE id = ${row.id}
      `;
      return r!;
    });

    expect(Number(stored.score)).toBe(87.5);
    expect(stored.feedback).toBe("Check your units.");
    expect(stored.grade_status).toBe("draft");
  });

  test("the teacher sees their own draft mark", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const graded = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 87.5,
        feedback: "Check your units.",
        publish: false,
        return_to_student: false,
      }),
    );

    const teacherView = toSubmissionResponse(graded, [], true);
    expect(teacherView.grade_status).toBe("draft");
    expect(teacherView.score).toBe(87.5);
    expect(teacherView.feedback).toBe("Check your units.");
  });

  test("publishing releases the mark to the student", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 87.5,
        feedback: "Well argued.",
        publish: true,
        return_to_student: false,
      }),
    );

    const studentView = await asUser(t.school.id, t.studentA.userId, async (tx) => {
      const stored = await getSubmission(tx, t.school.id, row.id);
      return toSubmissionResponse(stored!, [], false);
    });

    expect(studentView.grade_status).toBe("published");
    expect(studentView.status).toBe("graded");
    expect(studentView.score).toBe(87.5);
    expect(studentView.feedback).toBe("Well argued.");
    expect(studentView.graded_by_user_id).toBe(t.teacherA.userId);
  });

  test("a score above the assignment's maximum is refused", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
          score: 500,
          publish: true,
          return_to_student: false,
        }),
      ),
    ).rejects.toThrow(/exceeds the maximum/i);
  });

  test("publishing with no score is refused", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
          publish: true,
          return_to_student: false,
        }),
      ),
    ).rejects.toThrow(/score is required/i);
  });

  test("a draft save announces nothing; publishing announces submission.graded", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const gradedEvents = async () =>
      asOwner(t.school.id, async (tx) => {
        const [r] = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM app.outbox_events
          WHERE school_id = ${t.school.id} AND event_name = 'submission.graded'
        `;
        return Number(r!.n);
      });

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 70,
        publish: false,
        return_to_student: false,
      }),
    );
    // Announcing a draft would notify a student about a grade they cannot see.
    expect(await gradedEvents()).toBe(0);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 70,
        publish: true,
        return_to_student: false,
      }),
    );
    expect(await gradedEvents()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Parent access
// ---------------------------------------------------------------------------

describeDb("parent access", () => {
  test("a linked parent reads their child's submission", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const seen = await asUser(t.school.id, t.parent.id, (tx) =>
      getSubmission(tx, t.school.id, row.id),
    );

    expect(seen?.id).toBe(row.id);
  });

  test("an unlinked parent in the same school sees nothing", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const seen = await asUser(t.school.id, t.strangerParent.id, (tx) =>
      getSubmission(tx, t.school.id, row.id),
    );

    expect(seen).toBeNull();
  });

  test("a linked parent is withheld a draft mark and shown a published one", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 65,
        publish: false,
        return_to_student: false,
      }),
    );

    const parentView = async () =>
      asUser(t.school.id, t.parent.id, async (tx) => {
        // A parent is never staff, so the projection resolves the same way it does for the student.
        expect(await isStaffForAssignment(tx, t.assignmentId)).toBe(false);
        const stored = await getSubmission(tx, t.school.id, row.id);
        return toSubmissionResponse(stored!, [], false);
      });

    expect((await parentView()).score).toBeNull();

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 65,
        publish: true,
        return_to_student: false,
      }),
    );

    expect((await parentView()).score).toBe(65);
  });

  test("a parent cannot hand work in", async () => {
    const t = await seedWithAssignment();

    const studentId = await asUser(t.school.id, t.parent.id, (tx) =>
      resolveCallerStudentId(tx, t.school.id),
    );

    // No app.students row means there is nobody to attribute the work to. The route turns this
    // into a 403 rather than inventing an attribution.
    expect(studentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

describeDb("enrollment scope", () => {
  test("a student not enrolled in the class cannot submit", async () => {
    const t = await seedWithAssignment();
    // studentB is enrolled in class A; seed an assignment on class B instead, which neither is in.
    const otherAssignment = await seedAssignment(
      db.sql,
      t.school.id,
      t.classB.id,
      t.teacherB.userId,
    );

    await expect(submitAs(t.school.id, t.studentA.userId, otherAssignment)).rejects.toThrow(
      /not actively enrolled/i,
    );
  });

  test("a withdrawn student cannot resubmit but can still read their own work", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await db.sql`
      UPDATE app.enrollments
      SET status = 'withdrawn', withdrawn_at = CURRENT_TIMESTAMP
      WHERE school_id = ${t.school.id} AND class_id = ${t.classA.id}
        AND student_id = ${t.studentA.id}
    `;

    await expect(
      submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Late addition."),
    ).rejects.toThrow(/not actively enrolled/i);

    // Leaving a class does not confiscate work already handed in.
    const seen = await asUser(t.school.id, t.studentA.userId, (tx) =>
      getSubmission(tx, t.school.id, row.id),
    );
    expect(seen?.id).toBe(row.id);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant
// ---------------------------------------------------------------------------

describeDb("cross-tenant isolation", () => {
  test("a student in another school sees nothing", async () => {
    const a = await seedWithAssignment();
    const b = await seedTenant(db.sql);
    const { row } = await submitAs(a.school.id, a.studentA.userId, a.assignmentId);

    // Both the GUC and the service argument are scoped to the other tenant -- what a compromised
    // or buggy caller would look like, rather than a caller who merely asks politely.
    const seen = await asUser(b.school.id, b.studentA.userId, (tx) =>
      getSubmission(tx, b.school.id, row.id),
    );

    expect(seen).toBeNull();
  });

  test("a teacher in another school cannot grade", async () => {
    const a = await seedWithAssignment();
    const b = await seedTenant(db.sql);
    const { row } = await submitAs(a.school.id, a.studentA.userId, a.assignmentId);

    await expect(
      asUser(b.school.id, b.teacherA.userId, (tx) =>
        gradeSubmission(tx, b.school.id, b.teacherA.userId, row.id, {
          score: 100,
          publish: true,
          return_to_student: false,
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });

  test("listing another school's assignment returns nothing", async () => {
    const a = await seedWithAssignment();
    const b = await seedTenant(db.sql);
    await submitAs(a.school.id, a.studentA.userId, a.assignmentId);

    const page = await asUser(b.school.id, b.teacherA.userId, (tx) =>
      listSubmissions(tx, b.school.id, a.assignmentId, { limit: 50, offset: 0 }, true, null),
    );

    expect(page.total).toBe(0);
    expect(page.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describeDb("audit trail", () => {
  async function auditRows(schoolId: string, targetId: string) {
    return asOwner(schoolId, async (tx) => {
      return tx<
        {
          action: string;
          target_table: string;
          old_values: Record<string, unknown> | null;
          new_values: Record<string, unknown> | null;
        }[]
      >`
        SELECT action::text, target_table, old_values, new_values
        FROM app.audit_logs
        WHERE school_id = ${schoolId} AND target_id = ${targetId}
        ORDER BY created_at ASC
      `;
    });
  }

  test("a first hand-in records an insert", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const rows = await auditRows(t.school.id, row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("insert");
    expect(rows[0]!.target_table).toBe("assignment_submissions");
    expect(rows[0]!.old_values).toBeNull();
  });

  test("a resubmission records an update carrying the superseded attempt", async () => {
    // This is where the replaced work actually lives: the row is updated in place, so audit_logs
    // is the history.
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId, "First.");
    await submitAs(t.school.id, t.studentA.userId, t.assignmentId, "Second.");

    const rows = await auditRows(t.school.id, row.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.action).toBe("update");
    expect(rows[1]!.old_values?.attempt_number).toBe(1);
    expect(rows[1]!.new_values?.attempt_number).toBe(2);
  });

  test("a grade change records a real before/after diff", async () => {
    const t = await seedWithAssignment();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 91,
        publish: true,
        return_to_student: false,
      }),
    );

    const rows = await auditRows(t.school.id, row.id);
    const grade = rows.at(-1)!;
    expect(grade.action).toBe("update");
    expect(grade.old_values?.grade_status).toBe("none");
    expect(grade.new_values?.grade_status).toBe("published");
    expect(Number(grade.new_values?.score)).toBe(91);
  });

  test("a refused hand-in leaves no audit row", async () => {
    // The audit write shares the mutation's transaction, so a rollback takes both.
    const t = await seedWithAssignment({ dueAt: isoOffsetDays(-1), allowLate: false });

    await expect(submitAs(t.school.id, t.studentA.userId, t.assignmentId)).rejects.toThrow();

    const count = await asOwner(t.school.id, async (tx) => {
      const [r] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM app.audit_logs
        WHERE school_id = ${t.school.id} AND target_table = 'assignment_submissions'
      `;
      return Number(r!.n);
    });

    expect(count).toBe(0);
  });
});
