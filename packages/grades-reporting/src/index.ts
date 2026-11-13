/**
 * Shared published-grade calculation (student progress report, ST-176).
 *
 * The published grades API (apps/api/src/modules/grades/published) and the progress report worker
 * (apps/workers/src/queues/reports/progress-report.worker.ts) must render the exact same numbers:
 * the report's acceptance criteria require it to reconcile with the published grades API. This
 * package is the single implementation both callers import, mirroring how @studafy/attendance-
 * reporting is shared between the attendance report API and the attendance export worker.
 *
 * The rules are intentionally pinned here and covered by unit + reconciliation tests:
 *  - only `published` grade submissions with a non-null `published_at` count;
 *  - per-class percentage is the weight-weighted average of `score / max_score * 100`;
 *  - the letter grade and GPA points come from the class's term grading scheme when one is
 *    assigned, falling back to the school's inherited default boundaries;
 *  - the term GPA / average / credits are read from `app.student_term_summaries`, which the
 *    publication flow materializes, so the report always agrees with the released snapshot.
 */

import type { TransactionSql } from "postgres";

export type GradingSchemeType = "letter" | "percentage" | "gpa" | "numeric" | "pass_fail";

export interface GradeBoundary {
  label: string;
  min: number;
  max: number;
  gpa_points: number | null;
}

/** One published grade row as read from app.grades (column names preserved from the API port). */
export interface PublishedGradeRow {
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

export interface BoundaryRow {
  grading_scheme_id: string;
  label: string;
  min_percentage: string;
  gpa_points: string | null;
}

/** One class's published aggregate: credit-weighted percentage and its letter-grade GPA points. */
export interface ClassResult {
  classId: string;
  creditHours: number;
  percentage: number;
  gpaPoints: number | null;
}

/** The per-grade shape the published snapshot and the progress report both render. */
export interface PublishedGradeItem {
  id: string;
  grade_submission_id: string;
  gradebook_id: string;
  class: { id: string; code: string };
  course: { id: string; code: string; name: string; credit_hours: number };
  label: string;
  score: number | null;
  max_score: number;
  weight: number;
  percentage: number | null;
  grade_label: string | null;
  gpa_points: number | null;
  published_at: string;
}

export interface TermSummaryRow {
  term_gpa: string | null;
  term_average_percentage: string | null;
  total_credits: string;
  calculated_at: Date;
}

export interface SchoolSettingsRow {
  grading_scheme: string;
}

/** Unrounded term aggregates; callers apply `round2` where they persist or display them. */
export interface TermSummaryCalculation {
  term_gpa: number | null;
  term_average_percentage: number | null;
  total_credits: number;
}

export const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export function matchBoundary(
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

/**
 * Default grade boundaries per scheme type, derived from school_settings.grading_scheme.
 * Ported from apps/api gradebook-config-service so both processes agree on the fallback scale.
 */
export function getDefaultBoundaries(schemeType: GradingSchemeType): GradeBoundary[] {
  switch (schemeType) {
    case "letter":
      return [
        { label: "A", min: 90, max: 100, gpa_points: 4.0 },
        { label: "B", min: 80, max: 89, gpa_points: 3.0 },
        { label: "C", min: 70, max: 79, gpa_points: 2.0 },
        { label: "D", min: 60, max: 69, gpa_points: 1.0 },
        { label: "F", min: 0, max: 59, gpa_points: 0.0 },
      ];
    case "gpa":
      return [
        { label: "A", min: 90, max: 100, gpa_points: 4.0 },
        { label: "B", min: 80, max: 89, gpa_points: 3.0 },
        { label: "C", min: 70, max: 79, gpa_points: 2.0 },
        { label: "D", min: 60, max: 69, gpa_points: 1.0 },
        { label: "F", min: 0, max: 59, gpa_points: 0.0 },
      ];
    case "percentage":
      return [
        { label: "Excellent", min: 90, max: 100, gpa_points: null },
        { label: "Good", min: 80, max: 89, gpa_points: null },
        { label: "Average", min: 70, max: 79, gpa_points: null },
        { label: "Below Average", min: 60, max: 69, gpa_points: null },
        { label: "Failing", min: 0, max: 59, gpa_points: null },
      ];
    case "numeric":
      return [
        { label: "5", min: 90, max: 100, gpa_points: null },
        { label: "4", min: 80, max: 89, gpa_points: null },
        { label: "3", min: 70, max: 79, gpa_points: null },
        { label: "2", min: 60, max: 69, gpa_points: null },
        { label: "1", min: 0, max: 59, gpa_points: null },
      ];
    case "pass_fail":
      return [
        { label: "Pass", min: 60, max: 100, gpa_points: null },
        { label: "Fail", min: 0, max: 59, gpa_points: null },
      ];
  }
}

/**
 * Read the school's grading_scheme type from school_settings and return default boundaries.
 * Creates the settings row if it does not exist (lazy init, same as tenancy/settings/service).
 */
export async function getInheritedSchemeBoundaries(
  tx: TransactionSql,
  schoolId: string,
): Promise<{ schemeType: GradingSchemeType; boundaries: GradeBoundary[] }> {
  const [settings] = await tx<SchoolSettingsRow[]>`
    SELECT grading_scheme FROM app.school_settings WHERE school_id = ${schoolId}::uuid
  `;

  const schemeType = (settings?.grading_scheme ?? "letter") as GradingSchemeType;
  return { schemeType, boundaries: getDefaultBoundaries(schemeType) };
}

export async function loadPublishedGradeRows(
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

export async function loadBoundaries(
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

export async function calculateClasses(
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

/**
 * The shared snapshot of a student's published grades for a term: the per-grade breakdown (letter
 * label and GPA points per scored row) plus the per-class aggregates. The published grades API
 * builds its response from `grades` and reads the term summary via `queryStudentTermSummary`; the
 * progress report renders the same `grades` and `classes` so the two always reconcile.
 */
export async function calculateGradeBreakdown(
  tx: TransactionSql,
  schoolId: string,
  rows: readonly PublishedGradeRow[],
): Promise<{ classes: ClassResult[]; grades: PublishedGradeItem[] }> {
  const { classes, boundariesByScheme, fallbackBoundaries } = await calculateClasses(
    tx,
    schoolId,
    rows,
  );

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

  return { classes, grades };
}

/**
 * The term-level aggregates the publication flow materializes into app.student_term_summaries.
 * Returns unrounded numbers; the writer applies `round2` when persisting, callers display as-is.
 */
export function calculateTermSummary(classes: readonly ClassResult[]): TermSummaryCalculation {
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

  return { term_gpa: termGpa, term_average_percentage: termAverage, total_credits: totalCredits };
}

/** The published term summary row a snapshot/report reads, or null when none is materialized yet. */
export async function queryStudentTermSummary(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<TermSummaryRow | null> {
  const [summary] = await tx<TermSummaryRow[]>`
    SELECT term_gpa, term_average_percentage, total_credits, calculated_at
    FROM app.student_term_summaries
    WHERE school_id = ${schoolId}::uuid
      AND student_id = ${studentId}::uuid
      AND academic_term_id = ${termId}::uuid
  `;
  return summary ?? null;
}
