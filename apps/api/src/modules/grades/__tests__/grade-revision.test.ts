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
import { bulkDecision, listPendingApprovals } from "../approval-queue-service";
import {
  decideSubmission,
  ensureDraftSubmissions,
  getGradebookByClassId,
  submitSubmission,
} from "../grade-entry-service";
import {
  getLatestRevisionsForGradebook,
  requestRevision,
  withdrawRevision,
} from "../grade-revision-service";

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

async function asUserError(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<unknown>,
): Promise<(Error & { status?: number; code?: string }) | null> {
  return asUser(schoolId, userId, async (tx) => {
    try {
      await fn(tx);
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught : new Error(String(caught));
    }
  });
}

interface PublishedTenant {
  schoolId: string;
  teacherUserId: string;
  otherTeacherUserId: string;
  principalUserId: string;
  gradebookId: string;
  submissionId: string;
  gradeId: string;
}

/** A class whose one student has a published submission with a single grade of 70/100. */
async function seedPublishedTenant(sql: Sql): Promise<PublishedTenant> {
  const school = await createSchool(sql);
  const teacher = await createTeacher(sql, school.id);
  const otherTeacher = await createTeacher(sql, school.id);
  const principal = await createUser(sql, school.id, {
    email: `principal-${school.slug}@test.local`,
  });
  await assignRole(sql, school.id, principal.id, "PRINCIPAL");

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

  const seeded = await asUser(school.id, teacher.userId, async (tx) => {
    const gradebook = await getGradebookByClassId(tx, school.id, cls.id);
    const [draft] = await ensureDraftSubmissions(tx, school.id, gradebook.id, cls.id);
    const [grade] = await tx<{ id: string }[]>`
      INSERT INTO app.grades (school_id, grade_submission_id, score, max_score, label)
      VALUES (${school.id}::uuid, ${draft!.id}::uuid, 70, 100, 'Midterm')
      RETURNING id
    `;
    const submitted = await submitSubmission(
      tx,
      school.id,
      gradebook.id,
      draft!.id,
      draft!.updated_at.toISOString(),
      teacher.userId,
    );
    return { gradebookId: gradebook.id, submissionId: draft!.id, gradeId: grade!.id, submitted };
  });

  await asUser(school.id, principal.id, (tx) =>
    decideSubmission(
      tx,
      school.id,
      seeded.submissionId,
      "approve",
      seeded.submitted.updated_at.toISOString(),
      principal.id,
    ),
  );

  return {
    schoolId: school.id,
    teacherUserId: teacher.userId,
    otherTeacherUserId: otherTeacher.userId,
    principalUserId: principal.id,
    gradebookId: seeded.gradebookId,
    submissionId: seeded.submissionId,
    gradeId: seeded.gradeId,
  };
}

async function publishedScore(t: PublishedTenant): Promise<number | null> {
  const [row] = await db.sql<{ score: string | null }[]>`
    SELECT score FROM app.grades WHERE id = ${t.gradeId}::uuid
  `;
  return row!.score === null ? null : Number(row!.score);
}

function fileRevision(t: PublishedTenant, score: number | null, userId = t.teacherUserId) {
  return (tx: TransactionSql) =>
    requestRevision(tx, t.schoolId, t.gradebookId, t.submissionId, userId, {
      reason: "Mis-keyed the midterm",
      changes: [{ grade_id: t.gradeId, score }],
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeDb("grade revisions", () => {
  test("a filed revision leaves the published score in place until approved", async () => {
    const t = await seedPublishedTenant(db.sql);

    const revision = await asUser(t.schoolId, t.teacherUserId, fileRevision(t, 78));

    expect(revision.status).toBe("pending");
    expect(revision.changes).toEqual([{ grade_id: t.gradeId, previous_score: 70, new_score: 78 }]);
    expect(await publishedScore(t)).toBe(70);

    const latest = await asUser(t.schoolId, t.teacherUserId, (tx) =>
      getLatestRevisionsForGradebook(tx, t.schoolId, t.gradebookId),
    );
    expect(latest.get(t.submissionId)?.id).toBe(revision.id);
  });

  test("the principal sees it in the approvals queue and approving applies the new score", async () => {
    const t = await seedPublishedTenant(db.sql);
    const revision = await asUser(t.schoolId, t.teacherUserId, fileRevision(t, 78));

    const queue = await asUser(t.schoolId, t.principalUserId, (tx) =>
      listPendingApprovals(tx, t.schoolId),
    );
    const item = queue.items.find((candidate) => candidate.id === revision.id);
    expect(item?.item_type).toBe("grade_revision");
    expect(item?.diff).toMatchObject({
      grade_submission_id: t.submissionId,
      reason: "Mis-keyed the midterm",
      changes: [{ grade_id: t.gradeId, label: "Midterm", previous_score: 70, new_score: 78 }],
    });

    const result = await asUser(t.schoolId, t.principalUserId, (tx) =>
      bulkDecision(tx, t.schoolId, t.principalUserId, [
        { item_type: "grade_revision", id: revision.id, action: "approve" },
      ]),
    );

    expect(result.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(result.published).toEqual([{ submissionId: t.submissionId, eventId: revision.id }]);
    expect(await publishedScore(t)).toBe(78);
  });

  test("rejecting keeps the published score and records the reason", async () => {
    const t = await seedPublishedTenant(db.sql);
    const revision = await asUser(t.schoolId, t.teacherUserId, fileRevision(t, 95));

    const result = await asUser(t.schoolId, t.principalUserId, (tx) =>
      bulkDecision(tx, t.schoolId, t.principalUserId, [
        {
          item_type: "grade_revision",
          id: revision.id,
          action: "reject",
          rejection_reason: "Attach the marked paper first",
        },
      ]),
    );

    expect(result.summary.succeeded).toBe(1);
    expect(result.published).toEqual([]);
    expect(await publishedScore(t)).toBe(70);

    const latest = await asUser(t.schoolId, t.teacherUserId, (tx) =>
      getLatestRevisionsForGradebook(tx, t.schoolId, t.gradebookId),
    );
    expect(latest.get(t.submissionId)).toMatchObject({
      status: "rejected",
      rejection_reason: "Attach the marked paper first",
    });
  });

  test("only one revision per submission may be pending; withdrawing frees the slot", async () => {
    const t = await seedPublishedTenant(db.sql);
    const first = await asUser(t.schoolId, t.teacherUserId, fileRevision(t, 78));

    const duplicate = await asUserError(t.schoolId, t.teacherUserId, fileRevision(t, 80));
    expect(duplicate?.status).toBe(409);
    expect(duplicate?.code).toBe("GRADE_REVISION_ALREADY_PENDING");

    const withdrawn = await asUser(t.schoolId, t.teacherUserId, (tx) =>
      withdrawRevision(tx, t.schoolId, t.gradebookId, first.id),
    );
    expect(withdrawn.status).toBe("withdrawn");

    const second = await asUser(t.schoolId, t.teacherUserId, fileRevision(t, 80));
    expect(second.status).toBe("pending");
  });

  test("a revision that changes nothing is refused", async () => {
    const t = await seedPublishedTenant(db.sql);
    const error = await asUserError(t.schoolId, t.teacherUserId, fileRevision(t, 70));
    expect(error?.status).toBe(400);
  });

  test("a score above max_score is refused", async () => {
    const t = await seedPublishedTenant(db.sql);
    const error = await asUserError(t.schoolId, t.teacherUserId, fileRevision(t, 101));
    expect(error?.code).toBe("GRADE_SCORE_EXCEEDS_MAX");
  });

  test("a teacher who does not teach the class cannot file", async () => {
    const t = await seedPublishedTenant(db.sql);
    const error = await asUserError(
      t.schoolId,
      t.otherTeacherUserId,
      fileRevision(t, 78, t.otherTeacherUserId),
    );
    expect(error?.status).toBe(403);
  });

  test("a teacher cannot approve their own revision", async () => {
    const t = await seedPublishedTenant(db.sql);
    const revision = await asUser(t.schoolId, t.teacherUserId, fileRevision(t, 78));

    const result = await asUser(t.schoolId, t.teacherUserId, (tx) =>
      bulkDecision(tx, t.schoolId, t.teacherUserId, [
        { item_type: "grade_revision", id: revision.id, action: "approve" },
      ]),
    );

    expect(result.summary.failed).toBe(1);
    expect(await publishedScore(t)).toBe(70);
  });
});
