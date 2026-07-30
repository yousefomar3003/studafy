import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { getInheritedSchemeBoundaries } from "../config/gradebook-config-service";

import type { PublishedGradeSnapshot } from "./schemas";
import type { GradeBoundary } from "../config/schemas";
import type { TransactionSql } from "postgres";

interface PublishedGradeRow {
  id: string;
  grade_submission_id: string;
  gradebook_id: string;
  class_id: string;
  class_code: string;
  course_id: string;
  course_code: string;
  course_name: string;
  credit_hours: string;
  label: string;
  score: string | null;
  max_score: string;
  weight: string;
  published_at: Date;
  grading_scheme_id: string | null;
}

interface BoundaryRow {
  grading_scheme_id: string;
  label: string;
  min_percentage: string;
  gpa_points: string | null;
}

interface TermSummaryRow {
  term_gpa: string | null;
  term_average_percentage: string | null;
  total_credits: string;
  calculated_at: Date;
}

interface ClassResult {
  classId: string;
  creditHours: number;
  percentage: number;
  gpaPoints: number | null;
}

interface TermIdentity {
  term_id: string;
  academic_year_id: string;
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

function matchBoundary(
  percentage: number,
  boundaries: readonly Pick<GradeBoundary, "label" | "min" | "gpa_points">[],
): { label: string; gpaPoints: number | null } | null {
  const boundary = [...boundaries]
    .sort((a, b) => b.min - a.min)
    .find((candidate) => percentage >= candidate.min);

  if (!boundary) return null;
  return {
    label: boundary.label,
    gpaPoints: boundary.gpa_points ?? null,
  };
}

async function loadPublishedGradeRows(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<PublishedGradeRow[]> {
  return tx<PublishedGradeRow[]>`
    SELECT
      g.id,
      gs.id AS grade_submission_id,
      gb.id AS gradebook_id,
      c.id AS class_id,
      c.code AS class_code,
      co.id AS course_id,
      co.code AS course_code,
      co.name AS course_name,
      co.credit_hours,
      g.label,
      g.score,
      g.max_score,
      g.weight,
      gs.published_at,
      COALESCE(
        gb.grading_scheme_id,
        (
          SELECT scheme.id
          FROM app.grading_schemes AS scheme
          WHERE scheme.school_id = gs.school_id
            AND scheme.term_id = c.term_id
          ORDER BY scheme.version DESC
          LIMIT 1
        )
      ) AS grading_scheme_id
    FROM app.grade_submissions AS gs
    JOIN app.gradebooks AS gb
      ON gb.id = gs.gradebook_id AND gb.school_id = gs.school_id
    JOIN app.classes AS c
      ON c.id = gb.class_id AND c.school_id = gs.school_id
    JOIN app.courses AS co
      ON co.id = c.course_id AND co.school_id = gs.school_id
    JOIN app.grades AS g
      ON g.grade_submission_id = gs.id AND g.school_id = gs.school_id
    WHERE gs.school_id = ${schoolId}::uuid
      AND gs.student_id = ${studentId}::uuid
      AND gs.status = 'published'
      AND gs.published_at IS NOT NULL
      AND c.term_id = ${termId}::uuid
      AND g.score IS NOT NULL
    ORDER BY c.code, g.label, g.id
  `;
}

async function loadBoundaries(
  tx: TransactionSql,
  schoolId: string,
  rows: readonly PublishedGradeRow[],
): Promise<Map<string, GradeBoundary[]>> {
  const schemeIds = [
    ...new Set(rows.flatMap((row) => (row.grading_scheme_id ? [row.grading_scheme_id] : []))),
  ];

  const stored =
    schemeIds.length === 0
      ? []
      : await tx<BoundaryRow[]>`
          SELECT grading_scheme_id, label, min_percentage, gpa_points
          FROM app.grading_scheme_boundaries
          WHERE school_id = ${schoolId}::uuid
            AND grading_scheme_id = ANY (${schemeIds}::uuid[])
          ORDER BY grading_scheme_id, min_percentage DESC, position ASC
        `;

  const byScheme = new Map<string, GradeBoundary[]>();
  for (const row of stored) {
    const boundary: GradeBoundary = {
      label: row.label,
      min: Number(row.min_percentage),
      max: 100,
      gpa_points: row.gpa_points === null ? null : Number(row.gpa_points),
    };
    const current = byScheme.get(row.grading_scheme_id);
    if (current) current.push(boundary);
    else byScheme.set(row.grading_scheme_id, [boundary]);
  }

  return byScheme;
}

async function calculateClasses(
  tx: TransactionSql,
  schoolId: string,
  rows: readonly PublishedGradeRow[],
): Promise<{
  classes: ClassResult[];
  boundariesByScheme: Map<string, GradeBoundary[]>;
  fallbackBoundaries: GradeBoundary[];
}> {
  const boundariesByScheme = await loadBoundaries(tx, schoolId, rows);
  const { boundaries: fallbackBoundaries } = await getInheritedSchemeBoundaries(tx, schoolId);
  const byClass = new Map<string, PublishedGradeRow[]>();

  for (const row of rows) {
    const current = byClass.get(row.class_id);
    if (current) current.push(row);
    else byClass.set(row.class_id, [row]);
  }

  const classes: ClassResult[] = [];
  for (const [classId, classRows] of byClass) {
    let weightedPercentage = 0;
    let totalWeight = 0;

    for (const row of classRows) {
      if (row.score === null) continue;
      const weight = Number(row.weight);
      weightedPercentage += (Number(row.score) / Number(row.max_score)) * 100 * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) continue;
    const percentage = weightedPercentage / totalWeight;
    const first = classRows[0]!;
    const boundaries = first.grading_scheme_id
      ? (boundariesByScheme.get(first.grading_scheme_id) ?? fallbackBoundaries)
      : fallbackBoundaries;
    const grade = matchBoundary(percentage, boundaries);

    classes.push({
      classId,
      creditHours: Number(first.credit_hours),
      percentage,
      gpaPoints: grade?.gpaPoints ?? null,
    });
  }

  return { classes, boundariesByScheme, fallbackBoundaries };
}

export async function assertPublishedGradeAccess(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<void> {
  const [access] = await tx<{ allowed: boolean }[]>`
    SELECT (
      EXISTS (
        SELECT 1
        FROM app.students AS student
        WHERE student.school_id = ${schoolId}::uuid
          AND student.id = ${studentId}::uuid
          AND student.user_id = app.scope_user_id()
      )
      OR EXISTS (
        SELECT 1
        FROM app.parent_child_links AS link
        WHERE link.school_id = ${schoolId}::uuid
          AND link.student_id = ${studentId}::uuid
          AND link.parent_user_id = app.scope_user_id()
      )
    ) AS allowed
  `;

  if (!access?.allowed) {
    throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
  }
}

export async function assertTermExists(
  tx: TransactionSql,
  schoolId: string,
  termId: string,
): Promise<void> {
  const [term] = await tx<{ id: string }[]>`
    SELECT id
    FROM app.terms
    WHERE school_id = ${schoolId}::uuid AND id = ${termId}::uuid
  `;
  if (!term) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Academic term not found");
  }
}

export async function refreshStudentTermSummary(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  gradebookId: string,
): Promise<void> {
  const [identity] = await tx<TermIdentity[]>`
    SELECT c.term_id, c.academic_year_id
    FROM app.gradebooks AS gb
    JOIN app.classes AS c
      ON c.id = gb.class_id AND c.school_id = gb.school_id
    WHERE gb.school_id = ${schoolId}::uuid
      AND gb.id = ${gradebookId}::uuid
  `;
  if (!identity) {
    throw new CodedHttpException(404, ERROR_CODES.GRADEBOOK_NOT_FOUND, "Gradebook not found");
  }

  const rows = await loadPublishedGradeRows(tx, schoolId, studentId, identity.term_id);
  const { classes } = await calculateClasses(tx, schoolId, rows);
  const totalCredits = classes.reduce((sum, result) => sum + result.creditHours, 0);
  const termAverage =
    totalCredits === 0
      ? null
      : classes.reduce((sum, result) => sum + result.percentage * result.creditHours, 0) /
        totalCredits;
  const hasCompleteGpa = classes.length > 0 && classes.every((result) => result.gpaPoints !== null);
  const termGpa =
    totalCredits === 0 || !hasCompleteGpa
      ? null
      : classes.reduce((sum, result) => sum + result.gpaPoints! * result.creditHours, 0) /
        totalCredits;

  await tx`
    SELECT app.upsert_student_term_summary(
      ${schoolId}::uuid,
      ${studentId}::uuid,
      ${identity.term_id}::uuid,
      ${identity.academic_year_id}::uuid,
      ${termGpa === null ? null : String(round2(termGpa))}::numeric(7,2),
      ${termAverage === null ? null : String(round2(termAverage))}::numeric(7,2),
      ${String(round2(totalCredits))}::numeric(8,2)
    )
  `;
}

export async function getPublishedGradeSnapshot(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<PublishedGradeSnapshot> {
  const rows = await loadPublishedGradeRows(tx, schoolId, studentId, termId);
  const { boundariesByScheme, fallbackBoundaries } = await calculateClasses(tx, schoolId, rows);

  const grades = rows.map((row) => {
    const percentage =
      row.score === null ? null : (Number(row.score) / Number(row.max_score)) * 100;
    const boundaries = row.grading_scheme_id
      ? (boundariesByScheme.get(row.grading_scheme_id) ?? fallbackBoundaries)
      : fallbackBoundaries;
    const grade = percentage === null ? null : matchBoundary(percentage, boundaries);

    return {
      id: row.id,
      grade_submission_id: row.grade_submission_id,
      gradebook_id: row.gradebook_id,
      class: { id: row.class_id, code: row.class_code },
      course: {
        id: row.course_id,
        code: row.course_code,
        name: row.course_name,
        credit_hours: Number(row.credit_hours),
      },
      label: row.label,
      score: row.score === null ? null : Number(row.score),
      max_score: Number(row.max_score),
      weight: Number(row.weight),
      percentage: percentage === null ? null : round2(percentage),
      grade_label: grade?.label ?? null,
      gpa_points: grade?.gpaPoints ?? null,
      published_at: row.published_at.toISOString(),
    };
  });

  const [summary] = await tx<TermSummaryRow[]>`
    SELECT term_gpa, term_average_percentage, total_credits, calculated_at
    FROM app.student_term_summaries
    WHERE school_id = ${schoolId}::uuid
      AND student_id = ${studentId}::uuid
      AND academic_term_id = ${termId}::uuid
  `;

  const cumulativeRows = await tx<TermSummaryRow[]>`
    SELECT
      summary.term_gpa,
      summary.term_average_percentage,
      summary.total_credits,
      summary.calculated_at
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

  const cumulativeCredits = cumulativeRows.reduce((sum, row) => sum + Number(row.total_credits), 0);
  const cumulativeComplete =
    cumulativeRows.length > 0 &&
    cumulativeRows
      .filter((row) => Number(row.total_credits) > 0)
      .every((row) => row.term_gpa !== null);
  const cumulativeGpa =
    cumulativeCredits === 0 || !cumulativeComplete
      ? null
      : cumulativeRows.reduce(
          (sum, row) => sum + Number(row.term_gpa) * Number(row.total_credits),
          0,
        ) / cumulativeCredits;

  return {
    student_id: studentId,
    term_id: termId,
    grades,
    term_summary: {
      term_average_percentage:
        summary?.term_average_percentage === null || summary === undefined
          ? null
          : round2(Number(summary.term_average_percentage)),
      term_gpa:
        summary?.term_gpa === null || summary === undefined
          ? null
          : round2(Number(summary.term_gpa)),
      total_credits: summary ? round2(Number(summary.total_credits)) : 0,
      calculated_at: summary?.calculated_at.toISOString() ?? null,
    },
    cumulative_summary: {
      cumulative_gpa: cumulativeGpa === null ? null : round2(cumulativeGpa),
      total_credits: round2(cumulativeCredits),
      through_term_id: termId,
    },
  };
}
