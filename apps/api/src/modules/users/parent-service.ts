/**
 * The parent directory: every parent of the school with the details staff use to reach them (name,
 * email, phone, Studafy ID) and the children they are linked to, each with their class this year.
 *
 * Read in the caller's tenant transaction. The routes gate it on `user:read` (admins, principals,
 * finance), never on the record permissions: teachers and parents read records too, and a parent's
 * phone is not theirs to see.
 */

import { decodeKeysetCursor, encodeKeysetCursor } from "../../lib/keyset-cursor";

import type { TransactionSql } from "postgres";

export interface ParentChildRow {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  relationship: string;
  class_label: string | null;
}

export interface ParentRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  status: "invited" | "active" | "suspended" | "archived";
  member_code: string | null;
  last_login_at: Date | null;
  created_at: Date;
  children: ParentChildRow[];
}

export interface ListParentsParams {
  limit: number;
  cursor?: string;
  search?: string;
}

/** `%` and `_` typed into the search box are literal characters, not wildcards. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

async function childrenOf(
  tx: TransactionSql,
  parentIds: readonly string[],
): Promise<Map<string, ParentChildRow[]>> {
  const children = new Map<string, ParentChildRow[]>(parentIds.map((id) => [id, []]));
  if (parentIds.length === 0) return children;
  // The class is the section of the year imports place into: the active one, else the one being
  // planned (packages/student-import/src/plan.ts, slip-context.ts).
  const rows = await tx<(ParentChildRow & { parent_user_id: string })[]>`
    WITH year AS (
      SELECT id FROM app.academic_years
      WHERE school_id = current_setting('app.school_id')::uuid AND status IN ('active', 'planned')
      ORDER BY (status = 'active') DESC,
               (CURRENT_DATE BETWEEN starts_on AND ends_on) DESC,
               starts_on ASC
      LIMIT 1
    )
    SELECT l.parent_user_id, st.id AS student_id, st.first_name, st.last_name,
           st.admission_number, l.relationship::text AS relationship,
           (SELECT g.name || ' – ' || sec.name
            FROM app.student_sections AS ss
            JOIN year ON year.id = ss.academic_year_id
            JOIN app.sections AS sec ON sec.id = ss.section_id AND sec.school_id = ss.school_id
            JOIN app.grade_levels AS g ON g.id = sec.grade_level_id AND g.school_id = sec.school_id
            WHERE ss.student_id = st.id AND ss.school_id = st.school_id
            LIMIT 1) AS class_label
    FROM app.parent_child_links AS l
    JOIN app.students AS st ON st.id = l.student_id AND st.school_id = l.school_id
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND l.parent_user_id = ANY(${[...parentIds]}::uuid[])
    ORDER BY st.first_name, st.last_name, st.id
  `;
  for (const { parent_user_id, ...child } of rows) children.get(parent_user_id)?.push(child);
  return children;
}

/** Parents, newest first, searchable by name, email or Studafy ID (never matched on anything). */
export async function listParents(
  tx: TransactionSql,
  params: ListParentsParams,
): Promise<{ rows: ParentRow[]; next_cursor: string | null }> {
  const search = params.search?.trim();
  const searchFilter = search
    ? tx` AND (u.display_name ILIKE ${likePattern(search)}
             OR u.email ILIKE ${likePattern(search)}
             OR EXISTS (SELECT 1 FROM app.member_codes AS mc
                        WHERE mc.user_id = u.id AND mc.code ILIKE ${likePattern(search)}))`
    : tx``;
  const cursorFilter = params.cursor
    ? (() => {
        const { created_at, id } = decodeKeysetCursor(params.cursor);
        return tx` AND (u.created_at, u.id) < (${created_at}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const rows = await tx<Omit<ParentRow, "children">[]>`
    SELECT u.id AS user_id, u.display_name, u.email, u.phone, u.status::text AS status,
           (SELECT mc.code FROM app.member_codes AS mc
            WHERE mc.user_id = u.id AND mc.kind = 'PAR' LIMIT 1) AS member_code,
           u.last_login_at, u.created_at
    FROM app.users AS u
    WHERE u.school_id = current_setting('app.school_id')::uuid
      AND u.status <> 'archived'
      AND EXISTS (SELECT 1 FROM app.user_roles AS ur
                  WHERE ur.user_id = u.id AND ur.school_id = u.school_id AND ur.role = 'PARENT')
      ${searchFilter}
      ${cursorFilter}
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ${params.limit + 1}
  `;

  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  const next_cursor =
    rows.length > params.limit && last ? encodeKeysetCursor(last.created_at, last.user_id) : null;
  const children = await childrenOf(
    tx,
    page.map((row) => row.user_id),
  );
  return {
    rows: page.map((row) => ({ ...row, children: children.get(row.user_id) ?? [] })),
    next_cursor,
  };
}

/** One parent (any account holding the PARENT role), or undefined. */
export async function getParent(
  tx: TransactionSql,
  parentUserId: string,
): Promise<ParentRow | undefined> {
  const [row] = await tx<Omit<ParentRow, "children">[]>`
    SELECT u.id AS user_id, u.display_name, u.email, u.phone, u.status::text AS status,
           (SELECT mc.code FROM app.member_codes AS mc
            WHERE mc.user_id = u.id AND mc.kind = 'PAR' LIMIT 1) AS member_code,
           u.last_login_at, u.created_at
    FROM app.users AS u
    WHERE u.id = ${parentUserId}::uuid
      AND u.school_id = current_setting('app.school_id')::uuid
      AND EXISTS (SELECT 1 FROM app.user_roles AS ur
                  WHERE ur.user_id = u.id AND ur.school_id = u.school_id AND ur.role = 'PARENT')
  `;
  if (!row) return undefined;
  const children = await childrenOf(tx, [row.user_id]);
  return { ...row, children: children.get(row.user_id) ?? [] };
}
