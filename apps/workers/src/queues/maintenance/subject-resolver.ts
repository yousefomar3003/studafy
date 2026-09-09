/**
 * Resolves the identifiers a per-user DSR needs to scope by (ST-268).
 *
 * A person is `app.users.id` first, but most of what they generated is keyed by `app.students.id`
 * or `app.teachers.id` instead (db/migrations/000008) -- a submission is `student_id`, an evaluation
 * is `teacher_id`, neither is `user_id`. Resolving both role identities up front is what lets
 * tenant-erasure.worker.ts and tenant-export.worker.ts treat "find this person's rows in table T"
 * as one uniform lookup over SUBJECT_LINK_COLUMNS (retention-registry.ts) instead of writing a
 * student-shaped query and a teacher-shaped query separately.
 */

import { SUBJECT_LINK_COLUMNS } from "./retention-registry";

import type { ISql } from "postgres";

export interface SubjectIdentifiers {
  userId: string;
  studentId: string | null;
  teacherId: string | null;
}

export async function resolveSubjectIdentifiers(
  sql: ISql,
  schoolId: string,
  userId: string,
): Promise<SubjectIdentifiers> {
  const [studentRow, teacherRow] = await Promise.all([
    sql<{ id: string }[]>`
      SELECT id FROM app.students WHERE school_id = ${schoolId}::uuid AND user_id = ${userId}::uuid
    `,
    sql<{ id: string }[]>`
      SELECT id FROM app.teachers WHERE school_id = ${schoolId}::uuid AND user_id = ${userId}::uuid
    `,
  ]);

  return {
    userId,
    studentId: studentRow[0]?.id ?? null,
    teacherId: teacherRow[0]?.id ?? null,
  };
}

/**
 * The `(column, value)` pairs a redaction/export pass should scope by for this subject, restricted
 * to SUBJECT_LINK_COLUMNS entries the subject actually resolved an id for -- a person with no
 * app.teachers row contributes no `teacher_id` predicate, so a table's `teacher_id` column is never
 * matched against an id that could not possibly be theirs.
 */
export function subjectLinkValues(subject: SubjectIdentifiers): ReadonlyMap<string, string> {
  const values = new Map<string, string>([["user_id", subject.userId]]);
  if (subject.studentId) values.set("student_id", subject.studentId);
  if (subject.teacherId) values.set("teacher_id", subject.teacherId);
  return values;
}

/**
 * Which of SUBJECT_LINK_COLUMNS this table actually has, if any -- and, when it does, the id value
 * to scope by for this subject. `null` means the table cannot be scoped to one person by this
 * pipeline's rules (this iteration's documented boundary: a table that identifies a person only by
 * a differently-named column, e.g. `created_by`/`primary_parent_user_id`, is out of reach -- see
 * retention-registry.ts's SUBJECT_LINK_COLUMNS doc comment).
 */
export async function findSubjectPredicate(
  sql: ISql,
  table: string,
  subject: SubjectIdentifiers,
): Promise<{ column: string; value: string } | null> {
  // app.users' own primary key IS the subject -- it carries no `user_id` column to match against
  // (it has `id`), so SUBJECT_LINK_COLUMNS' generic sweep below can never reach it on its own. The
  // person's own identity row is the one table this pipeline cannot afford to silently skip.
  if (table === "users") return { column: "id", value: subject.userId };

  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${table}
      AND column_name = ANY(${SUBJECT_LINK_COLUMNS})
  `;
  const present = new Set(rows.map((row) => row.column_name));
  const values = subjectLinkValues(subject);

  for (const column of SUBJECT_LINK_COLUMNS) {
    if (present.has(column) && values.has(column)) {
      return { column, value: values.get(column)! };
    }
  }
  return null;
}
