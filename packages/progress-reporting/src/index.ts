/**
 * Shared query/schema surface for the student progress report (ST-176).
 *
 * The report type is a worker-side registry entry; its payload schema and the replica-scoped
 * queries it runs are shared here so a future API producer can enqueue and preview with the exact
 * same shapes. Grades and attendance sections delegate to @studafy/grades-reporting and
 * @studafy/attendance-reporting respectively — this package owns only what is specific to the
 * per-student progress report: the payload, the student/term identity the PDF header needs, and the
 * teacher term comments.
 */

import { z } from "zod";

import type { TransactionSql } from "postgres";

const uuidSchema = z.string().uuid();

export const progressReportJobDataSchema = z
  .object({
    version: z.literal(1),
    jobId: uuidSchema,
    schoolId: uuidSchema,
    requestedByUserId: uuidSchema,
    studentId: uuidSchema,
    termId: uuidSchema,
  })
  .strict();

export type ProgressReportJobData = z.infer<typeof progressReportJobDataSchema>;

export interface StudentIdentity {
  studentId: string;
  studentName: string;
  admissionNumber: string;
}

export interface TermInfo {
  termId: string;
  termName: string;
  startsOn: string;
  endsOn: string;
}

export interface TeacherTermComment {
  commentId: string;
  classCode: string;
  courseName: string;
  authorName: string;
  comment: string;
  updatedAt: string;
}

/**
 * Resolve the student the report is about. Returns null when the student does not exist in the
 * tenant or — because app.students is row-scoped — is not visible to the acting requester.
 */
export async function queryStudentIdentity(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<StudentIdentity | null> {
  const [row] = await tx<{ id: string; admission_number: string; student_name: string }[]>`
    SELECT id, admission_number,
           concat_ws(' ', first_name, middle_name, last_name) AS student_name
    FROM app.students
    WHERE school_id = ${schoolId} AND id = ${studentId}
  `;
  if (!row) return null;
  return {
    studentId: row.id,
    admissionNumber: row.admission_number,
    studentName: row.student_name,
  };
}

export async function queryTermInfo(
  tx: TransactionSql,
  schoolId: string,
  termId: string,
): Promise<TermInfo | null> {
  const [row] = await tx<{ id: string; name: string; starts_on: string; ends_on: string }[]>`
    SELECT id, name, starts_on::text AS starts_on, ends_on::text AS ends_on
    FROM app.terms
    WHERE school_id = ${schoolId} AND id = ${termId}
  `;
  if (!row) return null;
  return {
    termId: row.id,
    termName: row.name,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
  };
}

/**
 * Teacher comments for the student and term. Comments are row-scoped through the restrictive
 * role_scope_visibility policy (app.can_read_student), so a requester without the right scope
 * simply sees none. Author and course are LEFT-joined because their own scoping may hide them.
 */
export async function queryTeacherTermComments(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<TeacherTermComment[]> {
  const rows = await tx<
    {
      id: string;
      class_code: string;
      course_name: string;
      author_name: string | null;
      comment: string;
      updated_at: Date;
    }[]
  >`
    SELECT c.id, cl.code AS class_code, co.name AS course_name,
           u.display_name AS author_name, c.comment, c.updated_at
    FROM app.teacher_term_comments AS c
    JOIN app.classes AS cl
      ON cl.school_id = c.school_id AND cl.id = c.class_id
    JOIN app.courses AS co
      ON co.school_id = cl.school_id AND co.id = cl.course_id
    LEFT JOIN app.users AS u
      ON u.school_id = c.school_id AND u.id = c.author_user_id
    WHERE c.school_id = ${schoolId}
      AND c.student_id = ${studentId}
      AND c.academic_term_id = ${termId}
    ORDER BY cl.code, c.id
  `;
  return rows.map((row) => ({
    commentId: row.id,
    classCode: row.class_code,
    courseName: row.course_name,
    authorName: row.author_name ?? "",
    comment: row.comment,
    updatedAt: row.updated_at.toISOString(),
  }));
}
