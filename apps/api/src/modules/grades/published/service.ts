import { ERROR_CODES } from "@studafy/constants";
import {
  calculateClasses,
  calculateGradeBreakdown,
  calculateTermSummary,
  loadPublishedGradeRows,
  queryStudentTermSummary,
  round2,
} from "@studafy/grades-reporting";

import { CodedHttpException } from "../../../coded-http-exception";

import type { PublishedGradeSnapshot } from "./schemas";
import type { TransactionSql } from "postgres";

interface TermSummaryRow {
  term_gpa: string | null;
  term_average_percentage: string | null;
  total_credits: string;
  calculated_at: Date;
}

interface TermIdentity {
  term_id: string;
  academic_year_id: string;
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
  const { term_gpa, term_average_percentage, total_credits } = calculateTermSummary(classes);

  await tx`
    SELECT app.upsert_student_term_summary(
      ${schoolId}::uuid,
      ${studentId}::uuid,
      ${identity.term_id}::uuid,
      ${identity.academic_year_id}::uuid,
      ${term_gpa === null ? null : String(round2(term_gpa))}::numeric(7,2),
      ${term_average_percentage === null ? null : String(round2(term_average_percentage))}::numeric(7,2),
      ${String(round2(total_credits))}::numeric(8,2)
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
  const { grades } = await calculateGradeBreakdown(tx, schoolId, rows);

  const summary = await queryStudentTermSummary(tx, schoolId, studentId, termId);

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
        summary === null || summary.term_average_percentage === null
          ? null
          : round2(Number(summary.term_average_percentage)),
      term_gpa:
        summary === null || summary.term_gpa === null ? null : round2(Number(summary.term_gpa)),
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
