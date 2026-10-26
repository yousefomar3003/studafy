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
