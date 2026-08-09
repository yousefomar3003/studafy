/**
 * Submission attachment ownership, tenant boundary, and attempt stamping (ST-104).
 *
 * Integration tests requiring a live PostgreSQL instance. Object storage is faked -- the tests
 * here are about who may attach a file to whose work and which keys the database will accept, not
 * about S3, and the promotion mechanics themselves are already covered by
 * modules/academics/assignments/__tests__/promote.test.ts.
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
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../../tests/harness";
import {
  confirmSubmissionAttachment,
  createSubmissionUploadUrl,
  deleteSubmissionAttachment,
  listAttachmentsBySubmission,
} from "../submission-attachment-service";
import { resolveCallerStudentId, submitAssignment } from "../submission-service";

import type { PresignedUrl, StorageService } from "../../../../lib/storage";
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

/** An in-memory StorageService, mirroring the fake in the assignments promote tests. */
function fakeStorage(seed: Record<string, number> = {}): StorageService & {
  objects: Map<string, number>;
} {
  const objects = new Map<string, number>(Object.entries(seed));

  const base: StorageService = {
    ttlSeconds: 900,
    presign(key): PresignedUrl {
      return {
        url: `https://storage.example/${key}?signed`,
        expiresAt: new Date(Date.now() + 900_000),
      };
    },
    async exists(key) {
      return objects.has(key);
    },
    async size(key) {
      return objects.get(key) ?? 0;
    },
    async head(key) {
      return objects.has(key)
        ? { contentType: "application/pdf", sizeBytes: objects.get(key) ?? 0 }
        : null;
    },
    async checksumSha256(_key) {
      return "abcdef";
    },
    async copy(source, destination) {
      objects.set(destination, objects.get(source) ?? 0);
    },
    async remove(key) {
      objects.delete(key);
    },
    async *list(prefix) {
      for (const [key, sizeBytes] of objects) {
        if (key.startsWith(prefix)) yield { key, sizeBytes };
      }
    },
  };

  return Object.assign(base, { objects });
}

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

async function seedTenant(sql: Sql) {
  const school = await createSchool(sql);
  const teacher = await createTeacher(sql, school.id);
  const year = await createAcademicYear(sql, school.id);
  const term = await createTerm(sql, school.id, year.id);
  const subject = await createSubject(sql, school.id);
  const course = await createCourse(sql, school.id, subject.id);
  const room = await createRoom(sql, school.id);
  const klass = await createClass(sql, school.id, {
    courseId: course.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacher.id,
    roomId: room.id,
  });

  const studentA = await createStudent(sql, school.id);
  const studentB = await createStudent(sql, school.id);
  await createEnrollment(sql, school.id, klass.id, studentA.id);
  await createEnrollment(sql, school.id, klass.id, studentB.id);

  const [assignment] = await sql<{ id: string }[]>`
    INSERT INTO app.assignments (
      school_id, class_id, created_by_user_id, last_edited_by_user_id,
      title, status, assigned_at, due_at, max_score, allow_late_submission
    ) VALUES (
      ${school.id}, ${klass.id}, ${teacher.userId}, ${teacher.userId},
      'Essay', 'published', CURRENT_TIMESTAMP - interval '1 day',
      CURRENT_TIMESTAMP + interval '7 days', 100, true
    )
    RETURNING id
  `;

  return { school, teacher, klass, studentA, studentB, assignmentId: assignment!.id };
}

async function submitAs(schoolId: string, userId: string, assignmentId: string) {
  return asUser(schoolId, userId, async (tx) => {
    const studentId = await resolveCallerStudentId(tx, schoolId);
    return submitAssignment(tx, schoolId, userId, studentId!, assignmentId, {
      content: "See attached.",
    });
  });
}

/** Mint an upload URL, put the bytes in the fake bucket, and confirm -- the full three steps. */
async function attachFile(
  storage: ReturnType<typeof fakeStorage>,
  schoolId: string,
  userId: string,
  submissionId: string,
  fileName = "essay.pdf",
) {
  const minted = await asUser(schoolId, userId, (tx) =>
    createSubmissionUploadUrl(tx, storage, schoolId, submissionId, {
      file_name: fileName,
      content_type: "application/pdf",
    }),
  );

  storage.objects.set(minted.storage_key, 4096);

  return asUser(schoolId, userId, (tx) =>
    confirmSubmissionAttachment(tx, storage, schoolId, userId, submissionId, {
      storage_key: minted.storage_key,
      content_type: "application/pdf",
    }),
  );
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describeDb("submission attachment ownership", () => {
  test("the owning student can attach a file, promoted into permanent storage", async () => {
    const t = await seedTenant(db.sql);
    const storage = fakeStorage();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const attachment = await attachFile(storage, t.school.id, t.studentA.userId, row.id);

    expect(attachment.storage_key.startsWith(`permanent/${t.school.id}/`)).toBe(true);
    expect(Number(attachment.size_bytes)).toBe(4096);
    expect(attachment.original_file_name).toBe("essay.pdf");
    // Copy-then-delete: the staged object is gone, the permanent one exists.
    expect(storage.objects.has(attachment.storage_key)).toBe(true);
  });

  test("a classmate cannot mint an upload URL for another student's submission", async () => {
    const t = await seedTenant(db.sql);
    const storage = fakeStorage();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await expect(
      asUser(t.school.id, t.studentB.userId, (tx) =>
        createSubmissionUploadUrl(tx, storage, t.school.id, row.id, {
          file_name: "forged.pdf",
          content_type: "application/pdf",
        }),
      ),
      // 404 first, in fact: role_scope_visibility hides the row from studentB entirely, so they
      // cannot even reach the ownership check.
    ).rejects.toThrow(/not found|only attach files to your own/i);
  });

  test("a classmate cannot delete another student's attachment", async () => {
    const t = await seedTenant(db.sql);
    const storage = fakeStorage();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);
    const attachment = await attachFile(storage, t.school.id, t.studentA.userId, row.id);

    await expect(
      asUser(t.school.id, t.studentB.userId, (tx) =>
        deleteSubmissionAttachment(tx, t.school.id, row.id, attachment.id),
      ),
    ).rejects.toThrow(/not found|only attach files to your own/i);
  });

  test("the teacher can read the files they are marking but cannot alter them", async () => {
    const t = await seedTenant(db.sql);
    const storage = fakeStorage();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);
    const attachment = await attachFile(storage, t.school.id, t.studentA.userId, row.id);

    // Readable: app.can_read_submission (000049) resolves through app.teaches_assignment.
    const visible = await asUser(t.school.id, t.teacher.userId, (tx) =>
      listAttachmentsBySubmission(tx, t.school.id, [row.id]),
    );
    expect(visible.get(row.id)?.map((a) => a.id)).toEqual([attachment.id]);

    // Not alterable. The route gates this on submission:update, which INSTRUCTOR does not hold;
    // the service asserts ownership as the second half of the same rule.
    await expect(
      asUser(t.school.id, t.teacher.userId, (tx) =>
        deleteSubmissionAttachment(tx, t.school.id, row.id, attachment.id),
      ),
    ).rejects.toThrow(/only attach files to your own/i);
  });

  test("the owning student can delete their own attachment", async () => {
    const t = await seedTenant(db.sql);
    const storage = fakeStorage();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);
    const attachment = await attachFile(storage, t.school.id, t.studentA.userId, row.id);

    await asUser(t.school.id, t.studentA.userId, (tx) =>
      deleteSubmissionAttachment(tx, t.school.id, row.id, attachment.id),
    );

    const remaining = await asUser(t.school.id, t.studentA.userId, (tx) =>
      listAttachmentsBySubmission(tx, t.school.id, [row.id]),
    );
    expect(remaining.get(row.id) ?? []).toHaveLength(0);

    // The object is deliberately left behind: an S3 delete cannot roll back with the row.
    expect(storage.objects.has(attachment.storage_key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tenant boundary
// ---------------------------------------------------------------------------

describeDb("storage key tenant boundary", () => {
  test("another school's staged key is refused before any storage call", async () => {
    const t = await seedTenant(db.sql);
    const other = await seedTenant(db.sql);
    const storage = fakeStorage();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const foreignKey = `temp/${other.school.id}/00000000-0000-4000-8000-000000000000/x.pdf`;
    storage.objects.set(foreignKey, 100);

    await expect(
      asUser(t.school.id, t.studentA.userId, (tx) =>
        confirmSubmissionAttachment(tx, storage, t.school.id, t.studentA.userId, row.id, {
          storage_key: foreignKey,
          content_type: "application/pdf",
        }),
      ),
    ).rejects.toThrow(/forbidden|not permitted|403/i);

    // Nothing was copied into this school's prefix.
    expect([...storage.objects.keys()].some((k) => k.startsWith(`permanent/${t.school.id}/`))).toBe(
      false,
    );
  });

  test("the database refuses a row claiming another school's key", async () => {
    // The other half of the boundary. Even as studafy_admin, bypassing the application check
    // entirely, ck_submission_attachments_storage_key rejects the row.
    const t = await seedTenant(db.sql);
    const other = await seedTenant(db.sql);
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    await expect(
      db.sql`
        INSERT INTO app.submission_attachments (
          school_id, submission_id, uploaded_by_user_id,
          storage_key, original_file_name, mime_type, size_bytes
        ) VALUES (
          ${t.school.id}, ${row.id}, ${t.studentA.userId},
          ${`permanent/${other.school.id}/obj/x.pdf`}, 'x.pdf', 'application/pdf', 10
        )
      `,
    ).rejects.toThrow(/ck_submission_attachments_storage_key/i);
  });
});

// ---------------------------------------------------------------------------
// Attempt stamping
// ---------------------------------------------------------------------------

describeDb("attempt stamping", () => {
  test("files are stamped with the attempt they were handed in against", async () => {
    // Resubmission updates the submission in place, so without this a teacher could not tell which
    // version of the work a given file belonged to.
    const t = await seedTenant(db.sql);
    const storage = fakeStorage();
    const { row } = await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const first = await attachFile(storage, t.school.id, t.studentA.userId, row.id, "v1.pdf");
    expect(first.attempt_number).toBe(1);

    await submitAs(t.school.id, t.studentA.userId, t.assignmentId);

    const second = await attachFile(storage, t.school.id, t.studentA.userId, row.id, "v2.pdf");
    expect(second.attempt_number).toBe(2);

    const all = await asUser(t.school.id, t.studentA.userId, (tx) =>
      listAttachmentsBySubmission(tx, t.school.id, [row.id]),
    );
    // Ordered by attempt, so the current version's files group together at the end.
    expect(all.get(row.id)?.map((a) => a.attempt_number)).toEqual([1, 2]);
  });
});
