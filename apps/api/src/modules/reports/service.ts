/**
 * Data access for the parent child-comparison report (ST-177).
 *
 * The report is a composition of the three shared reporting surfaces so the numbers reconcile with
 * the published grades API, the attendance report API, and the student progress report:
 *  - grades + term summaries come from @studafy/grades-reporting (the same module the published
 *    grades API and the progress-report worker import);
 *  - attendance metrics/trends come from @studafy/attendance-reporting;
 *  - assignment completion is the one metric owned here (the comparison screen is its only
 *    consumer), and its SQL is deliberately scoped to the child's term classes.
 *
 * Authorization mirrors the published grades parent gate: routes assert the caller is a parent and
 * that each requested child is linked through app.parent_child_links; RLS additionally narrows
 * every scan to the same link set, so a regression in the route guard cannot widen the data.
 */

import {
  queryCompleteAttendanceReport,
  type AttendanceMetrics,
  type AttendanceTrendPoint,
  type ResolvedReportFilter,
} from "@studafy/attendance-reporting";
import { ERROR_CODES } from "@studafy/constants";
import {
  calculateGradeBreakdown,
  loadPublishedGradeRows,
  queryStudentTermSummary,
  round2,
} from "@studafy/grades-reporting";

import { CodedHttpException } from "../../coded-http-exception";

import type { TransactionSql } from "postgres";

export interface ChildIdentity {
  student_id: string;
  student_name: string;
  admission_number: string;
}

export interface GradeTrendPoint {
  term_id: string;
  term_name: string;
  term_average_percentage: number | null;
  term_gpa: number | null;
}

export interface AssignmentCompletion {
  total: number;
  submitted: number;
  on_time: number;
  late: number;
  completion_percent: number;
}

export interface ChildComparisonMetrics {
  grade: {
    term_average_percentage: number | null;
    term_gpa: number | null;
    total_credits: number;
  };
  grade_trend: GradeTrendPoint[];
  attendance: AttendanceMetrics;
  assignments: AssignmentCompletion;
}

export interface ChildBreakdownData {
  student: ChildIdentity;
  grade_trend: GradeTrendPoint[];
  grade: {
    grades: Awaited<ReturnType<typeof calculateGradeBreakdown>>["grades"];
    term_summary: {
      term_average_percentage: number | null;
      term_gpa: number | null;
      total_credits: number;
      calculated_at: string | null;
    };
  };
  attendance: {
    totals: AttendanceMetrics;
    trends: AttendanceTrendPoint[];
  };
  assignments: AssignmentCompletion;
}

const STUDENT_NAME_SQL = `concat_ws(' ', s.first_name, s.middle_name, s.last_name) AS student_name`;

/**
 * The children linked to this parent in this tenant, ordered deterministically for the mobile UI.
 */
export async function listLinkedChildren(
  tx: TransactionSql,
  schoolId: string,
  parentUserId: string,
): Promise<ChildIdentity[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT s.id AS student_id, ${tx.unsafe(STUDENT_NAME_SQL)}, s.admission_number
    FROM app.parent_child_links AS link
    JOIN app.students AS s
      ON s.id = link.student_id AND s.school_id = link.school_id
    WHERE link.school_id = ${schoolId}::uuid
      AND link.parent_user_id = ${parentUserId}::uuid
    ORDER BY s.first_name, s.middle_name, s.last_name, s.id
  `;
  return rows.map((row) => ({
    student_id: row.student_id as string,
    student_name: row.student_name as string,
    admission_number: row.admission_number as string,
  }));
}

/**
 * Resolve a single child's identity, or null when the student does not exist in this tenant.
 */
export async function queryChildIdentity(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<ChildIdentity | null> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT s.id AS student_id, ${tx.unsafe(STUDENT_NAME_SQL)}, s.admission_number
    FROM app.students AS s
    WHERE s.school_id = ${schoolId}::uuid AND s.id = ${studentId}::uuid
  `;
  if (!row) return null;
  return {
    student_id: row.student_id as string,
    student_name: row.student_name as string,
    admission_number: row.admission_number as string,
  };
}

/**
 * Assert the caller is the parent of the requested child. Throws 403 otherwise, mirroring the
 * published grades access gate; RLS keeps the same predicate true for every downstream scan.
 */
export async function assertChildLinked(
  tx: TransactionSql,
  schoolId: string,
  parentUserId: string,
  studentId: string,
): Promise<void> {
  const [link] = await tx<{ linked: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM app.parent_child_links
      WHERE school_id = ${schoolId}::uuid
        AND parent_user_id = ${parentUserId}::uuid
        AND student_id = ${studentId}::uuid
    ) AS linked
  `;
  if (!link?.linked) {
    throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
  }
}

/**
 * The child's term-grade trajectory through the requested term, from the materialized summaries
 * that also back the published grades API (same source, same numbers).
 */
export async function queryStudentTermGradeTrend(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<GradeTrendPoint[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT
      summary.academic_term_id AS term_id,
      term.name AS term_name,
      summary.term_average_percentage,
      summary.term_gpa
    FROM app.student_term_summaries AS summary
    JOIN app.terms AS term
      ON term.id = summary.academic_term_id
      AND term.academic_year_id = summary.academic_year_id
      AND term.school_id = summary.school_id
    JOIN app.academic_years AS year
      ON year.id = term.academic_year_id AND year.school_id = term.school_id
    JOIN app.terms AS target_term
      ON target_term.id = ${termId}::uuid AND target_term.school_id = summary.school_id
    JOIN app.academic_years AS target_year
      ON target_year.id = target_term.academic_year_id
      AND target_year.school_id = target_term.school_id
    WHERE summary.school_id = ${schoolId}::uuid
      AND summary.student_id = ${studentId}::uuid
      AND (
        year.starts_on < target_year.starts_on
        OR (
          year.starts_on = target_year.starts_on
          AND term.sequence_number <= target_term.sequence_number
        )
      )
    ORDER BY year.starts_on, term.sequence_number
  `;
  return rows.map((row) => ({
    term_id: row.term_id as string,
    term_name: row.term_name as string,
    term_average_percentage:
      row.term_average_percentage === null
        ? null
        : round2(Number(row.term_average_percentage as string)),
    term_gpa: row.term_gpa === null ? null : round2(Number(row.term_gpa as string)),
  }));
}

const HANDED_IN_STATUSES = ["submitted", "late", "graded", "returned"] as const;

/**
 * Per-child assignment completion for a term.
 *
 * "Total" counts published assignments in the classes the child is actively enrolled in for the
 * term. A submission counts as handed in once it leaves `draft`; lateness is the submission's
 * `is_late` flag (000049/000050 made it a boolean orthogonal to the lifecycle — grading never
 * clears it), not the vestigial `status = 'late'` enum value the app no longer writes.
 */
export async function queryAssignmentCompletion(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<AssignmentCompletion> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT
      count(a.id)::int AS total,
      count(s.id) FILTER (WHERE s.status IN ${tx(HANDED_IN_STATUSES)})::int AS submitted,
      count(s.id) FILTER (
        WHERE s.status IN ${tx(HANDED_IN_STATUSES)} AND s.is_late = false
      )::int AS on_time,
      count(s.id) FILTER (
        WHERE s.status IN ${tx(HANDED_IN_STATUSES)} AND s.is_late = true
      )::int AS late
    FROM app.assignments AS a
    JOIN app.classes AS c
      ON c.id = a.class_id AND c.school_id = a.school_id
    LEFT JOIN app.assignment_submissions AS s
      ON s.assignment_id = a.id
      AND s.school_id = a.school_id
      AND s.student_id = ${studentId}::uuid
    WHERE a.school_id = ${schoolId}::uuid
      AND a.status = 'published'
      AND c.term_id = ${termId}::uuid
      AND EXISTS (
        SELECT 1
        FROM app.enrollments AS e
        WHERE e.school_id = ${schoolId}::uuid
          AND e.class_id = c.id
          AND e.student_id = ${studentId}::uuid
          AND e.status = 'active'
      )
  `;
  const total = Number(row?.total ?? 0);
  const submitted = Number(row?.submitted ?? 0);
  const onTime = Number(row?.on_time ?? 0);
  const late = Number(row?.late ?? 0);
  return {
    total,
    submitted,
    on_time: onTime,
    late,
    completion_percent: total === 0 ? 0 : round2((submitted / total) * 100),
  };
}

function mapTermSummary(summary: {
  term_gpa: string | null;
  term_average_percentage: string | null;
  total_credits: string;
  calculated_at: Date;
}) {
  return {
    term_average_percentage:
      summary.term_average_percentage === null
        ? null
        : round2(Number(summary.term_average_percentage)),
    term_gpa: summary.term_gpa === null ? null : round2(Number(summary.term_gpa)),
    total_credits: round2(Number(summary.total_credits)),
    calculated_at: summary.calculated_at.toISOString(),
  };
}

/**
 * The comparison metrics for one child: term grade snapshot, grade trend, attendance totals, and
 * assignment completion.
 */
export async function collectChildComparison(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  termId: string,
  filter: ResolvedReportFilter,
): Promise<ChildComparisonMetrics> {
  const [summary, gradeTrend, attendance, assignments] = await Promise.all([
    queryStudentTermSummary(tx, schoolId, studentId, termId),
    queryStudentTermGradeTrend(tx, schoolId, studentId, termId),
    queryCompleteAttendanceReport(tx, schoolId, { ...filter, studentId }, "student", "week"),
    queryAssignmentCompletion(tx, schoolId, studentId, termId),
  ]);

  return {
    grade: summary
      ? {
          term_average_percentage:
            summary.term_average_percentage === null
              ? null
              : round2(Number(summary.term_average_percentage)),
          term_gpa: summary.term_gpa === null ? null : round2(Number(summary.term_gpa)),
          total_credits: round2(Number(summary.total_credits)),
        }
      : {
          term_average_percentage: null,
          term_gpa: null,
          total_credits: 0,
        },
    grade_trend: gradeTrend,
    attendance: attendance.summary.totals,
    assignments,
  };
}

/**
 * The full per-child breakdown: identity, grade trend, per-course published grades with the term
 * summary, attendance totals + trend, and assignment completion.
 */
export async function collectChildBreakdown(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  termId: string,
  filter: ResolvedReportFilter,
): Promise<ChildBreakdownData> {
  const [student, gradeTrend, summary, gradeRows, attendance, assignments] = await Promise.all([
    queryChildIdentity(tx, schoolId, studentId),
    queryStudentTermGradeTrend(tx, schoolId, studentId, termId),
    queryStudentTermSummary(tx, schoolId, studentId, termId),
    loadPublishedGradeRows(tx, schoolId, studentId, termId),
    queryCompleteAttendanceReport(tx, schoolId, { ...filter, studentId }, "student", "week"),
    queryAssignmentCompletion(tx, schoolId, studentId, termId),
  ]);

  if (!student) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Student not found");
  }

  const { grades } = await calculateGradeBreakdown(tx, schoolId, gradeRows);

  return {
    student,
    grade_trend: gradeTrend,
    grade: {
      grades,
      term_summary: summary
        ? mapTermSummary(summary)
        : {
            term_average_percentage: null,
            term_gpa: null,
            total_credits: 0,
            calculated_at: null,
          },
    },
    attendance: {
      totals: attendance.summary.totals,
      trends: attendance.trends,
    },
    assignments,
  };
}
