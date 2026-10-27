import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { setTenantScope, withSystemTx } from "../../../db/tenant-tx";

import type { Database } from "../../../db/client";
import type { TransactionSql } from "postgres";

export interface StudentIdentity {
  id: string;
  name: string;
  admission_number: string;
}

/**
 * A read that can name and count students for a finance user.
 *
 * FINANCE holds no `student:read`, and `app.students`' role-scope policy hides every student from
 * it, yet billing is meaningless without knowing who is billed: picking a student, naming one on an
 * award, resolving an invoice batch's targets. This runs as `studafy_admin`, which that restrictive
 * policy does not name, with tenant isolation armed, so the read still cannot leave the caller's
 * school. Callers select identity columns only (id, name, admission number) and sit behind a
 * `billing:*` guard; never use it for anything that writes.
 */
export function withStudentIdentityTx<T>(
  database: Database,
  schoolId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withSystemTx(database, async (tx) => {
    await setTenantScope(tx, schoolId);
    return fn(tx);
  });
}

/**
 * `withStudentIdentityTx` for a finance action that writes on a family's behalf: notifying a
 * family's guardians writes app.notifications rows addressed to them and reads their notification
 * preferences, both of which studafy_app may only do for the caller's own rows. The acting user and
 * request id are set as well, so the audit trail names who sent it. Callers sit behind a
 * `billing:update` guard and write only notices and their log.
 */
export function withFinanceActorTx<T>(
  database: Database,
  actor: { schoolId: string; userId: string; requestId?: string },
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withSystemTx(database, async (tx) => {
    await setTenantScope(tx, actor.schoolId, actor.requestId);
    await tx`SELECT set_config('app.user_id', ${actor.userId}, true)`;
    return fn(tx);
  });
}

/**
 * The school's current students by name, for a pick-from-the-list field: every student when
 * `search` is empty, otherwise those whose name contains it. Identity columns only.
 */
export async function searchStudentIdentities(
  tx: TransactionSql,
  schoolId: string,
  search: string,
  limit: number,
): Promise<StudentIdentity[]> {
  const term = search.trim();
  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const nameFilter = term
    ? tx`AND (first_name || ' ' || last_name ILIKE ${pattern}
          OR coalesce(preferred_name, '') || ' ' || last_name ILIKE ${pattern})`
    : tx``;
  return tx<StudentIdentity[]>`
    SELECT id, coalesce(preferred_name, first_name) || ' ' || last_name AS name, admission_number
    FROM app.students
    WHERE school_id = ${schoolId}::uuid
      AND status <> 'withdrawn'
      ${nameFilter}
    ORDER BY coalesce(preferred_name, first_name), last_name, id
    LIMIT ${limit}
  `;
}

/**
 * The students an invoice batch bills: actively `enrolled` students only — every one, those actively
 * enrolled in one of `classIds`, or exactly `studentIds`. Class membership lives in
 * `app.enrollments` (000009), not on `app.students`. Chosen students that are not enrolled here are
 * refused rather than silently dropped, so "bill these three" never quietly bills two.
 */
export async function resolveBillableStudentIds(
  tx: TransactionSql,
  schoolId: string,
  target: { classIds?: string[]; studentIds?: string[] },
): Promise<string[]> {
  if (target.studentIds && target.studentIds.length > 0) {
    const requested = [...new Set(target.studentIds)];
    const rows = await tx<{ id: string }[]>`
      SELECT id FROM app.students
      WHERE school_id = ${schoolId}::uuid
        AND status = 'enrolled'
        AND id = ANY(${requested}::uuid[])
    `;
    if (rows.length !== requested.length) {
      const found = new Set(rows.map((r) => r.id));
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Not enrolled students of this school: ${requested.filter((id) => !found.has(id)).join(", ")}`,
      );
    }
    return requested;
  }

  if (target.classIds && target.classIds.length > 0) {
    const rows = await tx<{ id: string }[]>`
      SELECT DISTINCT s.id
      FROM app.students s
      JOIN app.enrollments e
        ON e.student_id = s.id AND e.school_id = s.school_id AND e.status = 'active'
      WHERE s.school_id = ${schoolId}::uuid
        AND s.status = 'enrolled'
        AND e.class_id = ANY(${target.classIds}::uuid[])
    `;
    return rows.map((r) => r.id);
  }

  const rows = await tx<{ id: string }[]>`
    SELECT id FROM app.students
    WHERE school_id = ${schoolId}::uuid AND status = 'enrolled'
  `;
  return rows.map((r) => r.id);
}

export interface StudentFamily {
  student_name: string;
  family_id: string | null;
  family_name: string | null;
}

/**
 * Each student's name and family, for labelling finance rows (payments, invoices) that carry only a
 * student id. A student in two families is labelled with the older one. Identity columns only; run
 * it through `withStudentIdentityTx`.
 */
export async function studentFamilies(
  tx: TransactionSql,
  schoolId: string,
  studentIds: readonly string[],
): Promise<Map<string, StudentFamily>> {
  const ids = [...new Set(studentIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx<({ student_id: string } & StudentFamily)[]>`
    SELECT student.id AS student_id,
           coalesce(student.preferred_name, student.first_name) || ' ' || student.last_name
             AS student_name,
           family.id AS family_id, family.display_name AS family_name
    FROM app.students AS student
    LEFT JOIN LATERAL (
      SELECT family.id, family.display_name
      FROM app.parent_child_links AS link
      JOIN app.families AS family
        ON family.id = link.family_id AND family.school_id = link.school_id
      WHERE link.school_id = student.school_id AND link.student_id = student.id
      ORDER BY family.created_at, family.id
      LIMIT 1
    ) AS family ON true
    WHERE student.school_id = ${schoolId}::uuid AND student.id = ANY(${ids}::uuid[])
  `;
  return new Map(rows.map(({ student_id, ...family }) => [student_id, family]));
}
