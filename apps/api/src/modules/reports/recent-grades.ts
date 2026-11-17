/**
 * The parent home's "Recent grades": the newest marks across every child linked to the calling
 * parent, both kinds the app keeps apart -- exam marks school leadership approved and released
 * (the rows `GET /api/grading/students/{studentId}/marks` serves) and published gradebook grades
 * (the rows the published grades API and the child breakdown serve).
 *
 * Built to be cheap enough for every home load: one query per kind, each driven from the caller's
 * own app.parent_child_links rows, newest first and capped at `limit` in SQL, then merged and
 * capped again here. RLS narrows every scan to the same link set, so a regression in the
 * link-driven WHERE cannot widen what a parent sees.
 */

import type { TransactionSql } from "postgres";

export type MarkStatus = "graded" | "absent" | "excused" | "not_applicable";

export interface RecentGradeItem {
  kind: "exam" | "assignment";
  id: string;
  student_id: string;
  student_first_name: string;
  student_name: string;
  name: string;
  subject_name: string;
  term_name: string | null;
  released_at: string;
  attempt: number;
  status: MarkStatus;
  score: number | null;
  max_score: number;
  descriptor_label: string | null;
}

const STUDENT_NAME_SQL = `concat_ws(' ', s.first_name, s.middle_name, s.last_name)`;

interface Row {
  id: string;
  student_id: string;
  student_first_name: string;
  student_name: string;
  name: string;
  subject_name: string;
  term_name: string | null;
  released_at: Date;
  attempt: number;
  status: MarkStatus;
  score: string | null;
  max_score: string;
  descriptor_label: string | null;
}

/**
 * The newest released exam marks of the parent's linked children: one row per assessment (the
 * retake when there is one), released when its own approval or its period's approved mark sheet
 * reached the family, whichever came first.
 */
async function recentExamMarks(
  tx: TransactionSql,
  schoolId: string,
  parentUserId: string,
  limit: number,
): Promise<Row[]> {
  return tx<Row[]>`
    SELECT * FROM (
      SELECT DISTINCT ON (mark.student_id, assessment.id)
             assessment.id, mark.student_id, s.first_name AS student_first_name,
             ${tx.unsafe(STUDENT_NAME_SQL)} AS student_name,
             assessment.name, subject.name AS subject_name, term.name AS term_name,
             LEAST(sheet.decided_at, release_row.decided_at) AS released_at,
             mark.attempt, mark.status, mark.score, assessment.max_marks AS max_score,
             descriptor.label AS descriptor_label
      FROM app.parent_child_links AS link
      JOIN app.students AS s ON s.id = link.student_id AND s.school_id = link.school_id
      JOIN app.student_marks AS mark
        ON mark.student_id = link.student_id AND mark.school_id = link.school_id
      LEFT JOIN app.grade_program_descriptors AS descriptor
        ON descriptor.id = mark.descriptor_id AND descriptor.school_id = mark.school_id
      JOIN app.subject_config_assessments AS assessment
        ON assessment.id = mark.assessment_id AND assessment.school_id = mark.school_id
      JOIN app.subject_configs AS config
        ON config.id = assessment.subject_config_id AND config.school_id = assessment.school_id
      JOIN app.student_sections AS placement
        ON placement.student_id = mark.student_id
       AND placement.academic_year_id = assessment.academic_year_id
       AND placement.school_id = mark.school_id
      LEFT JOIN app.mark_sheets AS sheet
        ON sheet.school_id = mark.school_id
       AND sheet.academic_year_id = assessment.academic_year_id
       AND sheet.section_id = placement.section_id
       AND sheet.subject_id = config.subject_id
       AND sheet.term_id IS NOT DISTINCT FROM assessment.term_id
       AND sheet.status = 'approved'
      LEFT JOIN app.assessment_mark_releases AS release_row
        ON release_row.school_id = mark.school_id
       AND release_row.section_id = placement.section_id
       AND release_row.assessment_id = assessment.id
       AND release_row.status = 'approved'
      JOIN app.subjects AS subject
        ON subject.id = config.subject_id AND subject.school_id = mark.school_id
      LEFT JOIN app.terms AS term ON term.id = assessment.term_id AND term.school_id = mark.school_id
      WHERE link.school_id = ${schoolId}::uuid
        AND link.parent_user_id = ${parentUserId}::uuid
        AND assessment.status = 'active'
        AND (assessment.section_id IS NULL OR assessment.section_id = placement.section_id)
        AND (sheet.id IS NOT NULL OR release_row.id IS NOT NULL)
      ORDER BY mark.student_id, assessment.id, mark.attempt DESC
    ) AS latest
    ORDER BY released_at DESC, id
    LIMIT ${limit}
  `;
}

/** The newest published gradebook grades of the parent's linked children. */
async function recentAssignmentGrades(
  tx: TransactionSql,
  schoolId: string,
  parentUserId: string,
  limit: number,
): Promise<Row[]> {
  return tx<Row[]>`
    SELECT g.id, gs.student_id, s.first_name AS student_first_name,
           ${tx.unsafe(STUDENT_NAME_SQL)} AS student_name,
           g.label AS name, co.name AS subject_name, NULL::text AS term_name,
           gs.published_at AS released_at, 1 AS attempt, 'graded' AS status,
           g.score, g.max_score, NULL::text AS descriptor_label
    FROM app.parent_child_links AS link
    JOIN app.students AS s ON s.id = link.student_id AND s.school_id = link.school_id
    JOIN app.grade_submissions AS gs
      ON gs.student_id = link.student_id AND gs.school_id = link.school_id
    JOIN app.gradebooks AS gb ON gb.id = gs.gradebook_id AND gb.school_id = gs.school_id
    JOIN app.classes AS c ON c.id = gb.class_id AND c.school_id = gs.school_id
    JOIN app.courses AS co ON co.id = c.course_id AND co.school_id = gs.school_id
    JOIN app.grades AS g ON g.grade_submission_id = gs.id AND g.school_id = gs.school_id
    WHERE link.school_id = ${schoolId}::uuid
      AND link.parent_user_id = ${parentUserId}::uuid
      AND gs.status = 'published'
      AND gs.published_at IS NOT NULL
      AND g.score IS NOT NULL
    ORDER BY gs.published_at DESC, g.id
    LIMIT ${limit}
  `;
}

function toItem(kind: RecentGradeItem["kind"], row: Row): RecentGradeItem {
  return {
    kind,
    id: row.id,
    student_id: row.student_id,
    student_first_name: row.student_first_name,
    student_name: row.student_name,
    name: row.name,
    subject_name: row.subject_name,
    term_name: row.term_name,
    released_at: row.released_at.toISOString(),
    attempt: Number(row.attempt),
    status: row.status,
    score: row.score === null ? null : Number(row.score),
    max_score: Number(row.max_score),
    descriptor_label: row.descriptor_label,
  };
}

/**
 * Up to [limit] of the newest exam marks and assignment grades across the parent's linked
 * children, newest first; on a tie an exam mark comes first.
 */
export async function listRecentChildGrades(
  tx: TransactionSql,
  schoolId: string,
  parentUserId: string,
  limit: number,
): Promise<RecentGradeItem[]> {
  const exams = await recentExamMarks(tx, schoolId, parentUserId, limit);
  const assignments = await recentAssignmentGrades(tx, schoolId, parentUserId, limit);
  const items = [
    ...exams.map((row) => toItem("exam", row)),
    ...assignments.map((row) => toItem("assignment", row)),
  ];
  // Array.prototype.sort is stable, so ties keep exams first and each query's own order.
  items.sort((a, b) => Date.parse(b.released_at) - Date.parse(a.released_at));
  return items.slice(0, limit);
}
