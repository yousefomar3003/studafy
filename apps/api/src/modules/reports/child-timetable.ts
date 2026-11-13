/**
 * Data access for a parent's read-only view of one linked child's weekly timetable.
 *
 * The timetable shown is the one the student app itself shows (`currentTermProvider` +
 * `approvedTimetableVersionProvider` in the mobile app): the approved version of the school's
 * current term, narrowed to the classes the child is actively enrolled in. Callers must assert the
 * parent-child link first (see `assertChildLinked`); RLS additionally narrows slot and class reads
 * to classes the caller may see.
 */

import { getTimetableSettings, type TimetableSettingsRow } from "../academics/timetable-service";

import type { TransactionSql } from "postgres";

export interface ChildTimetableSlot {
  id: string;
  weekday: number;
  period: number;
  class: { id: string; code: string };
  course: { id: string; code: string; name: string } | null;
  teacher: { id: string; name: string } | null;
  room: { id: string; name: string } | null;
}

export interface ChildTimetable {
  student_id: string;
  term_id: string | null;
  timetable_version_id: string | null;
  settings: TimetableSettingsRow;
  slots: ChildTimetableSlot[];
}

/**
 * The school's current term: an active term in an active academic year (what the mobile app
 * resolves), falling back to an active term elsewhere, then to any term whose dates contain today.
 * Ties go to the most recently started term.
 */
async function resolveCurrentTermId(tx: TransactionSql, schoolId: string): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    SELECT t.id
    FROM app.terms t
    JOIN app.academic_years y ON y.id = t.academic_year_id AND y.school_id = t.school_id
    WHERE t.school_id = ${schoolId}::uuid
      AND (t.status = 'active' OR CURRENT_DATE BETWEEN t.starts_on AND t.ends_on)
    ORDER BY (t.status = 'active' AND y.status = 'active') DESC,
             (t.status = 'active') DESC,
             (CURRENT_DATE BETWEEN t.starts_on AND t.ends_on) DESC,
             t.starts_on DESC
    LIMIT 1
  `;
  return row?.id ?? null;
}

async function resolveApprovedVersionId(
  tx: TransactionSql,
  schoolId: string,
  termId: string,
): Promise<string | null> {
  // uq_timetable_versions_one_approved_per_term keeps this to at most one row; the ORDER BY only
  // makes the pick deterministic should that ever change.
  const [row] = await tx<{ id: string }[]>`
    SELECT id
    FROM app.timetable_versions
    WHERE school_id = ${schoolId}::uuid
      AND term_id = ${termId}::uuid
      AND status = 'approved'
    ORDER BY approved_at DESC NULLS LAST
    LIMIT 1
  `;
  return row?.id ?? null;
}

interface SlotRow {
  id: string;
  weekday: number;
  period: number;
  class_id: string;
  class_code: string;
  course_id: string | null;
  course_code: string | null;
  course_name: string | null;
  teacher_id: string | null;
  teacher_name: string | null;
  room_id: string | null;
  room_name: string | null;
}

async function listChildSlots(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  versionId: string,
): Promise<ChildTimetableSlot[]> {
  const rows = await tx<SlotRow[]>`
    SELECT s.id, s.weekday::int AS weekday, s.period::int AS period,
           cl.id AS class_id, cl.code AS class_code,
           co.id AS course_id, co.code AS course_code, co.name AS course_name,
           te.id AS teacher_id, COALESCE(u.display_name, u.email) AS teacher_name,
           r.id AS room_id, r.name AS room_name
    FROM app.timetable_slots s
    JOIN app.classes cl ON cl.id = s.class_id AND cl.school_id = s.school_id
    JOIN app.enrollments e
      ON e.class_id = s.class_id
     AND e.school_id = s.school_id
     AND e.student_id = ${studentId}::uuid
     AND e.status = 'active'
    LEFT JOIN app.courses co ON co.id = cl.course_id AND co.school_id = s.school_id
    LEFT JOIN app.teachers te ON te.id = s.teacher_id AND te.school_id = s.school_id
    LEFT JOIN app.users u ON u.id = te.user_id AND u.school_id = s.school_id
    LEFT JOIN app.rooms r ON r.id = s.room_id AND r.school_id = s.school_id
    WHERE s.school_id = ${schoolId}::uuid
      AND s.timetable_version_id = ${versionId}::uuid
    ORDER BY s.weekday ASC, s.period ASC, cl.code ASC
  `;

  return rows.map((row) => ({
    id: row.id,
    weekday: row.weekday,
    period: row.period,
    class: { id: row.class_id, code: row.class_code },
    course:
      row.course_id && row.course_code !== null && row.course_name !== null
        ? { id: row.course_id, code: row.course_code, name: row.course_name }
        : null,
    teacher:
      row.teacher_id && row.teacher_name !== null
        ? { id: row.teacher_id, name: row.teacher_name }
        : null,
    room: row.room_id && row.room_name !== null ? { id: row.room_id, name: row.room_name } : null,
  }));
}

/** The child's live weekly timetable plus the school's teaching week that frames it. */
export async function collectChildTimetable(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<ChildTimetable> {
  const settings = await getTimetableSettings(tx, schoolId);
  const termId = await resolveCurrentTermId(tx, schoolId);
  const versionId = termId ? await resolveApprovedVersionId(tx, schoolId, termId) : null;
  const slots = versionId ? await listChildSlots(tx, schoolId, studentId, versionId) : [];

  return {
    student_id: studentId,
    term_id: termId,
    timetable_version_id: versionId,
    settings,
    slots,
  };
}
