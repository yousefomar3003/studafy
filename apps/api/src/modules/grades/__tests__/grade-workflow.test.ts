// eslint-disable-next-line import-x/no-unresolved
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
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
} from "../../../../tests/harness";
import {
  decideSubmission,
  ensureDraftSubmissions,
  getGradebookByClassId,
  getSubmissionsWithGrades,
  submitSubmission,
  unlockSubmission,
} from "../grade-entry-service";

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

interface WorkflowTenant {
  schoolId: string;
  teacherUserId: string;
  teacherId: string;
  adminUserId: string;
  studentId: string;
  cls: { id: string };
  term: { id: string };
}

async function seedWorkflowTenant(sql: Sql): Promise<WorkflowTenant> {
  const school = await createSchool(sql);
  const teacher = await createTeacher(sql, school.id);
  const user = await createUser(sql, school.id, {
    email: `admin-${school.slug}@test.local`,
  });
  await assignRole(sql, school.id, user.id, "ORG_ADMIN");
  const adminUserId = user.id;

  const year = await createAcademicYear(sql, school.id);
  const term = await createTerm(sql, school.id, year.id);
  const subject = await createSubject(sql, school.id);
  const course = await createCourse(sql, school.id, subject.id);
  const room = await createRoom(sql, school.id);

  const cls = await createClass(sql, school.id, {
    courseId: course.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacher.id,
    roomId: room.id,
  });

  const student = await createStudent(sql, school.id);
  await createEnrollment(sql, school.id, cls.id, student.id);

  return {
    schoolId: school.id,
    teacherUserId: teacher.userId,
    teacherId: teacher.id,
    adminUserId,
    studentId: student.id,
    cls,
    term,
  };
}

async function seedGradeRecord(
  sql: Sql,
  schoolId: string,
  submissionId: string,
  overrides?: { label?: string; score?: number | null; maxScore?: number },
): Promise<string> {
  return asAdminOnly(sql, schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.grades (school_id, grade_submission_id, score, max_score, label)
      VALUES (
        ${schoolId}::uuid,
        ${submissionId}::uuid,
        ${overrides?.score !== undefined ? String(overrides.score) : null}::numeric(10,2),
        ${overrides?.maxScore ?? 100}::numeric(10,2),
        ${overrides?.label ?? "Test Grade"}
      )
      RETURNING id
    `;
    return row!.id;
  });
}

async function asAdminOnly<T>(
  sql: Sql,
  schoolId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

// ---------------------------------------------------------------------------
// Workflow integration tests
// ---------------------------------------------------------------------------

describeDb("grade submission workflow", () => {
  test("submit transitions draft to submitted", async () => {
    const t = await seedWorkflowTenant(db.sql);

    const submission = await asUser(t.schoolId, t.teacherUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
      const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

      const { updated_at } = draft;
      return submitSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        updated_at.toISOString(),
        t.teacherUserId,
      );
    });

    expect(submission.status).toBe("submitted");
    expect(submission.submitted_by_user_id).toBe(t.teacherUserId);
    expect(submission.submitted_at).not.toBeNull();
    expect(submission.decided_by_user_id).toBeNull();
    expect(submission.decided_at).toBeNull();
    expect(submission.rejection_reason).toBeNull();
  });

  test("approve transitions submitted to published", async () => {
    const t = await seedWorkflowTenant(db.sql);

    const published = await asUser(t.schoolId, t.adminUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
      const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

      const submitted = await submitSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        draft.updated_at.toISOString(),
        t.teacherUserId,
      );
      return decideSubmission(
        tx,
        t.schoolId,
        draft.id,
        "approve",
        submitted.updated_at.toISOString(),
        t.adminUserId,
      );
    });

    expect(published.status).toBe("published");
    expect(published.submitted_by_user_id).toBe(t.teacherUserId);
    expect(published.decided_by_user_id).toBe(t.adminUserId);
    expect(published.submitted_at).not.toBeNull();
    expect(published.decided_at).not.toBeNull();
    expect(published.rejection_reason).toBeNull();
  });

  test("reject requires a reason", async () => {
    const t = await seedWorkflowTenant(db.sql);

    await expect(
      asUser(t.schoolId, t.adminUserId, async (tx) => {
        const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
        const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

        const submitted = await submitSubmission(
          tx,
          t.schoolId,
          gradebook.id,
          draft.id,
          draft.updated_at.toISOString(),
          t.teacherUserId,
        );
        return decideSubmission(
          tx,
          t.schoolId,
          draft.id,
          "reject",
          submitted.updated_at.toISOString(),
          t.adminUserId,
        );
      }),
    ).rejects.toThrow(/rejection reason/i);
  });

  test("reject transitions submitted to rejected with reason", async () => {
    const t = await seedWorkflowTenant(db.sql);

    const rejected = await asUser(t.schoolId, t.adminUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
      const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

      const submitted = await submitSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        draft.updated_at.toISOString(),
        t.teacherUserId,
      );
      return decideSubmission(
        tx,
        t.schoolId,
        draft.id,
        "reject",
        submitted.updated_at.toISOString(),
        t.adminUserId,
        "Scores require adjustment",
      );
    });

    expect(rejected.status).toBe("rejected");
    expect(rejected.rejection_reason).toBe("Scores require adjustment");
    expect(rejected.decided_by_user_id).toBe(t.adminUserId);
    expect(rejected.decided_at).not.toBeNull();
  });

  test("reject then unlock then resubmit completes the full loop", async () => {
    const t = await seedWorkflowTenant(db.sql);

    const result = await asUser(t.schoolId, t.teacherUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
      const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

      // Teacher submits
      const submitted = await submitSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        draft.updated_at.toISOString(),
        t.teacherUserId,
      );

      // Admin rejects
      const rejected = await decideSubmission(
        tx,
        t.schoolId,
        draft.id,
        "reject",
        submitted.updated_at.toISOString(),
        t.adminUserId,
        "Needs revisions",
      );

      // Teacher unlocks
      const unlocked = await unlockSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        rejected.updated_at.toISOString(),
      );

      // Teacher resubmits
      const resubmitted = await submitSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        unlocked.updated_at.toISOString(),
        t.teacherUserId,
      );

      // Admin approves
      const published = await decideSubmission(
        tx,
        t.schoolId,
        draft.id,
        "approve",
        resubmitted.updated_at.toISOString(),
        t.adminUserId,
      );

      return { unlocked, rejected, resubmitted, published };
    });

    expect(result.unlocked.status).toBe("draft");
    expect(result.unlocked.rejection_reason).toBeNull();
    expect(result.unlocked.submitted_by_user_id).toBeNull();
    expect(result.unlocked.decided_by_user_id).toBeNull();

    expect(result.rejected.status).toBe("rejected");
    expect(result.rejected.rejection_reason).toBe("Needs revisions");

    expect(result.resubmitted.status).toBe("submitted");

    expect(result.published.status).toBe("published");
    expect(result.published.decided_by_user_id).toBe(t.adminUserId);
  });

  test("non-teacher cannot submit", async () => {
    const t = await seedWorkflowTenant(db.sql);

    await expect(
      asUser(t.schoolId, t.adminUserId, async (tx) => {
        const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
        const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);
        return submitSubmission(
          tx,
          t.schoolId,
          gradebook.id,
          draft.id,
          draft.updated_at.toISOString(),
          t.adminUserId,
        );
      }),
    ).rejects.toThrow(/only the assigned teacher/i);
  });

  test("non-admin cannot decide", async () => {
    const t = await seedWorkflowTenant(db.sql);

    await expect(
      asUser(t.schoolId, t.teacherUserId, async (tx) => {
        const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
        const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

        const submitted = await submitSubmission(
          tx,
          t.schoolId,
          gradebook.id,
          draft.id,
          draft.updated_at.toISOString(),
          t.teacherUserId,
        );
        return decideSubmission(
          tx,
          t.schoolId,
          draft.id,
          "approve",
          submitted.updated_at.toISOString(),
          t.teacherUserId,
        );
      }),
    ).rejects.toThrow(/only school administrators/i);
  });

  test("invalid transitions are rejected at app level", async () => {
    const t = await seedWorkflowTenant(db.sql);

    // Cannot approve a draft
    await expect(
      asUser(t.schoolId, t.adminUserId, async (tx) => {
        const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
        const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);
        return decideSubmission(
          tx,
          t.schoolId,
          draft.id,
          "approve",
          draft.updated_at.toISOString(),
          t.adminUserId,
        );
      }),
    ).rejects.toThrow(/cannot transition/i);

    // Cannot submit an already submitted submission
    await expect(
      asUser(t.schoolId, t.teacherUserId, async (tx) => {
        const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
        const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

        const submitted = await submitSubmission(
          tx,
          t.schoolId,
          gradebook.id,
          draft.id,
          draft.updated_at.toISOString(),
          t.teacherUserId,
        );
        return submitSubmission(
          tx,
          t.schoolId,
          gradebook.id,
          draft.id,
          submitted.updated_at.toISOString(),
          t.teacherUserId,
        );
      }),
    ).rejects.toThrow(/cannot transition/i);
  });

  test("grade records are present in submission response after full cycle", async () => {
    const t = await seedWorkflowTenant(db.sql);

    const published = await asUser(t.schoolId, t.adminUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
      const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

      // Seed a grade record for this submission
      await seedGradeRecord(db.sql, t.schoolId, draft.id, {
        label: "Final Exam",
        score: 88,
        maxScore: 100,
      });

      const submitted = await submitSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        draft.updated_at.toISOString(),
        t.teacherUserId,
      );
      return decideSubmission(
        tx,
        t.schoolId,
        draft.id,
        "approve",
        submitted.updated_at.toISOString(),
        t.adminUserId,
      );
    });

    expect(published.status).toBe("published");

    const loaded = await asUser(t.schoolId, t.adminUserId, (tx) =>
      getSubmissionsWithGrades(tx, t.schoolId, published.gradebook_id),
    );

    const match = loaded.find((s) => s.id === published.id);
    expect(match).toBeDefined();
    expect(match!.grades).toHaveLength(1);
    expect(match!.grades[0]!.label).toBe("Final Exam");
    expect(Number(match!.grades[0]!.score)).toBe(88);
  });

  test("grade submission workflow: concurrency guard rejects stale updated_at", async () => {
    const t = await seedWorkflowTenant(db.sql);

    await expect(
      asUser(t.schoolId, t.teacherUserId, async (tx) => {
        const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
        const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

        // Use a stale updated_at token
        const staleToken = new Date(0).toISOString();
        return submitSubmission(
          tx,
          t.schoolId,
          gradebook.id,
          draft.id,
          staleToken,
          t.teacherUserId,
        );
      }),
    ).rejects.toThrow(/modified by another user/i);
  });

  test("audit trail records every transition", async () => {
    const t = await seedWorkflowTenant(db.sql);

    const result = await asUser(t.schoolId, t.teacherUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
      const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

      const submitted = await submitSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        draft.updated_at.toISOString(),
        t.teacherUserId,
      );
      const rejected = await decideSubmission(
        tx,
        t.schoolId,
        draft.id,
        "reject",
        submitted.updated_at.toISOString(),
        t.adminUserId,
        "Revise",
      );
      const unlocked = await unlockSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        rejected.updated_at.toISOString(),
      );
      const resubmitted = await submitSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        unlocked.updated_at.toISOString(),
        t.teacherUserId,
      );
      const published = await decideSubmission(
        tx,
        t.schoolId,
        draft.id,
        "approve",
        resubmitted.updated_at.toISOString(),
        t.adminUserId,
      );

      return { submissionId: draft.id, published };
    });

    // Verify audit rows exist for all transitions
    const auditRows = await db.sql.begin(
      (tx) =>
        tx<{ action: string; new_values: unknown }[]>`
        SELECT action, new_values
        FROM app.audit_logs
        WHERE school_id = ${t.schoolId}
          AND target_table = 'grade_submissions'
          AND target_id = ${result.submissionId}
        ORDER BY created_at ASC
      `,
    );

    expect(auditRows.map((r) => r.action)).toEqual([
      "update",
      "update",
      "update",
      "update",
      "update",
    ]);
    expect(JSON.stringify(auditRows)).toContain("submitted");
    expect(JSON.stringify(auditRows)).toContain("rejected");
    expect(JSON.stringify(auditRows)).toContain("approved");
    expect(JSON.stringify(auditRows)).toContain("published");
  });

  test("outbox events are emitted on submit and publish", async () => {
    const t = await seedWorkflowTenant(db.sql);

    await asUser(t.schoolId, t.adminUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.cls.id);
      const [draft] = await ensureDraftSubmissions(tx, t.schoolId, gradebook.id, t.cls.id);

      const submitted = await submitSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        draft.id,
        draft.updated_at.toISOString(),
        t.teacherUserId,
      );
      const published = await decideSubmission(
        tx,
        t.schoolId,
        draft.id,
        "approve",
        submitted.updated_at.toISOString(),
        t.adminUserId,
      );

      return { submitted, published };
    });

    const events = await db.sql.begin(
      (tx) =>
        tx<{ event_name: string; payload: unknown }[]>`
        SELECT event_name, payload
        FROM app.outbox_events
        WHERE school_id = ${t.schoolId}
        ORDER BY id ASC
      `,
    );

    expect(events).toHaveLength(2);
    expect(events[0]!.event_name).toBe("grades.submitted");
    expect(events[1]!.event_name).toBe("grades.published");
  });
});
