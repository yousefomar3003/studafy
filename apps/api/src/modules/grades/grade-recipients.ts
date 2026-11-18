import type { TransactionSql } from "postgres";

/**
 * Who hears that a student's grades were published (QA-031): the student's own account and their
 * linked guardians, as far as the publishing transaction may see them. The realtime gateway
 * delivers grades.published to exactly these users' rooms and to no role room.
 */
export async function gradeRecipients(tx: TransactionSql, studentId: string): Promise<string[]> {
  const rows = await tx<{ user_id: string }[]>`
    SELECT s.user_id::text AS user_id
    FROM app.students AS s
    WHERE s.id = ${studentId}::uuid
      AND s.school_id = current_setting('app.school_id')::uuid
      AND s.user_id IS NOT NULL
    UNION
    SELECT l.parent_user_id::text
    FROM app.parent_child_links AS l
    WHERE l.student_id = ${studentId}::uuid
      AND l.school_id = current_setting('app.school_id')::uuid
  `;
  return rows.map((row) => row.user_id);
}
