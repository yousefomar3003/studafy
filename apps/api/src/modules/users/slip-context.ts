/**
 * What a login slip says besides the ID and code: a student's class, so slips can be sorted and
 * handed out class by class, and a parent's children, so a parent's slip can go home with them.
 * Read in the administrator's tenant transaction, so it shows only what they may see.
 */

import type { TransactionSql } from "postgres";

export interface SlipContext {
  classLabel: string | null;
  children: string[];
}

export async function loginSlipContext(
  tx: TransactionSql,
  userIds: readonly string[],
): Promise<Map<string, SlipContext>> {
  const context = new Map<string, SlipContext>(
    userIds.map((id) => [id, { classLabel: null, children: [] }]),
  );
  if (userIds.length === 0) return context;
  const ids = [...userIds];

  // The section the student sits in, in the year an import places into (the active one, else the
  // one being planned; packages/student-import/src/plan.ts).
  const classes = await tx<{ user_id: string; label: string }[]>`
    WITH year AS (
      SELECT id FROM app.academic_years
      WHERE school_id = current_setting('app.school_id')::uuid AND status IN ('active', 'planned')
      ORDER BY (status = 'active') DESC,
               (CURRENT_DATE BETWEEN starts_on AND ends_on) DESC,
               starts_on ASC
      LIMIT 1
    )
    SELECT st.user_id, g.name || ' – ' || sec.name AS label
    FROM app.students AS st
    JOIN app.student_sections AS ss ON ss.student_id = st.id AND ss.school_id = st.school_id
    JOIN year ON year.id = ss.academic_year_id
    JOIN app.sections AS sec ON sec.id = ss.section_id AND sec.school_id = ss.school_id
    JOIN app.grade_levels AS g ON g.id = sec.grade_level_id AND g.school_id = sec.school_id
    WHERE st.school_id = current_setting('app.school_id')::uuid
      AND st.user_id = ANY(${ids}::uuid[])
  `;
  for (const row of classes) context.get(row.user_id)!.classLabel = row.label;

  const children = await tx<{ parent_user_id: string; name: string }[]>`
    SELECT l.parent_user_id, btrim(st.first_name || ' ' || st.last_name) AS name
    FROM app.parent_child_links AS l
    JOIN app.students AS st ON st.id = l.student_id AND st.school_id = l.school_id
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND l.parent_user_id = ANY(${ids}::uuid[])
    ORDER BY st.first_name, st.last_name
  `;
  for (const row of children) context.get(row.parent_user_id)!.children.push(row.name);

  return context;
}
