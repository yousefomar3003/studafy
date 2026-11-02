import type { TransactionSql } from "postgres";

/**
 * People finance cannot reach through a family: enrolled students no guardian is linked to (no
 * sibling discount, no family account, no parent who can see or pay their invoices) and PARENT
 * accounts linked to no child. Nothing here links anyone -- it only lists who still needs staff to
 * link them, and staff pick the link themselves. Identity columns only; run through
 * `withStudentIdentityTx` (`../students/service.ts`), since FINANCE cannot read app.students.
 */

export interface UnlinkedListParams {
  search?: string;
  limit: number;
  offset: number;
}

export interface UnlinkedStudent {
  id: string;
  name: string;
  admission_number: string;
  created_at: string;
}

export interface UnlinkedParent {
  user_id: string;
  name: string;
  email: string | null;
  status: "invited" | "active" | "suspended" | "archived";
  created_at: string;
}

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function studentFilter(tx: TransactionSql, schoolId: string, search?: string) {
  const term = search?.trim();
  const nameFilter = term
    ? tx`AND (s.first_name || ' ' || s.last_name ILIKE ${likePattern(term)}
          OR coalesce(s.preferred_name, '') || ' ' || s.last_name ILIKE ${likePattern(term)}
          OR s.admission_number ILIKE ${likePattern(term)})`
    : tx``;
  return tx`
    s.school_id = ${schoolId}::uuid
    AND s.status = 'enrolled'
    AND NOT EXISTS (
      SELECT 1 FROM app.parent_child_links AS link
      WHERE link.school_id = s.school_id AND link.student_id = s.id
    )
    ${nameFilter}
  `;
}

function parentFilter(tx: TransactionSql, schoolId: string, search?: string) {
  const term = search?.trim();
  const nameFilter = term
    ? tx`AND (u.display_name ILIKE ${likePattern(term)} OR u.email ILIKE ${likePattern(term)})`
    : tx``;
  return tx`
    u.school_id = ${schoolId}::uuid
    AND u.status <> 'archived'
    AND EXISTS (
      SELECT 1 FROM app.user_roles AS role
      WHERE role.school_id = u.school_id AND role.user_id = u.id AND role.role = 'PARENT'
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.parent_child_links AS link
      WHERE link.school_id = u.school_id AND link.parent_user_id = u.id
    )
    ${nameFilter}
  `;
}

/** Enrolled students with no guardian link, by name. */
export async function listUnlinkedStudents(
  tx: TransactionSql,
  schoolId: string,
  params: UnlinkedListParams,
): Promise<{ students: UnlinkedStudent[]; total: number }> {
  const [count] = await tx<{ total: number }[]>`
    SELECT count(*)::int AS total FROM app.students AS s
    WHERE ${studentFilter(tx, schoolId, params.search)}
  `;
  const rows = await tx<(Omit<UnlinkedStudent, "created_at"> & { created_at: Date })[]>`
    SELECT s.id,
           coalesce(s.preferred_name, s.first_name) || ' ' || s.last_name AS name,
           s.admission_number,
           s.created_at
    FROM app.students AS s
    WHERE ${studentFilter(tx, schoolId, params.search)}
    ORDER BY coalesce(s.preferred_name, s.first_name), s.last_name, s.id
    LIMIT ${params.limit} OFFSET ${params.offset}
  `;
  return {
    students: rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
    total: count?.total ?? 0,
  };
}

/** PARENT accounts (not archived) linked to no child, by name. */
export async function listUnlinkedParents(
  tx: TransactionSql,
  schoolId: string,
  params: UnlinkedListParams,
): Promise<{ parents: UnlinkedParent[]; total: number }> {
  const [count] = await tx<{ total: number }[]>`
    SELECT count(*)::int AS total FROM app.users AS u
    WHERE ${parentFilter(tx, schoolId, params.search)}
  `;
  const rows = await tx<(Omit<UnlinkedParent, "created_at"> & { created_at: Date })[]>`
    SELECT u.id AS user_id,
           coalesce(nullif(btrim(u.display_name), ''), u.email, '') AS name,
           u.email,
           u.status,
           u.created_at
    FROM app.users AS u
    WHERE ${parentFilter(tx, schoolId, params.search)}
    ORDER BY coalesce(nullif(btrim(u.display_name), ''), u.email, ''), u.id
    LIMIT ${params.limit} OFFSET ${params.offset}
  `;
  return {
    parents: rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
    total: count?.total ?? 0,
  };
}

/** How many of each the lists above hold, for a count the school notices. */
export async function countUnlinked(
  tx: TransactionSql,
  schoolId: string,
): Promise<{ students: number; parents: number }> {
  const [row] = await tx<{ students: number; parents: number }[]>`
    SELECT
      (SELECT count(*)::int FROM app.students AS s WHERE ${studentFilter(tx, schoolId)}) AS students,
      (SELECT count(*)::int FROM app.users AS u WHERE ${parentFilter(tx, schoolId)}) AS parents
  `;
  return { students: row?.students ?? 0, parents: row?.parents ?? 0 };
}

/**
 * Which of `studentIds` belong to no family (no guardian link), for the invoice batch preflight:
 * how many, and the first `limit` of them by name.
 */
export async function studentsWithoutFamily(
  tx: TransactionSql,
  schoolId: string,
  studentIds: readonly string[],
  limit: number,
): Promise<{ count: number; students: Omit<UnlinkedStudent, "created_at">[] }> {
  const ids = [...new Set(studentIds)];
  if (ids.length === 0) return { count: 0, students: [] };
  const rows = await tx<(Omit<UnlinkedStudent, "created_at"> & { total: number })[]>`
    SELECT s.id,
           coalesce(s.preferred_name, s.first_name) || ' ' || s.last_name AS name,
           s.admission_number,
           count(*) OVER ()::int AS total
    FROM app.students AS s
    WHERE s.school_id = ${schoolId}::uuid
      AND s.id = ANY(${ids}::uuid[])
      AND NOT EXISTS (
        SELECT 1 FROM app.parent_child_links AS link
        WHERE link.school_id = s.school_id AND link.student_id = s.id
      )
    ORDER BY coalesce(s.preferred_name, s.first_name), s.last_name, s.id
    LIMIT ${limit}
  `;
  return {
    count: rows[0]?.total ?? 0,
    students: rows.map(({ total: _total, ...student }) => student),
  };
}
