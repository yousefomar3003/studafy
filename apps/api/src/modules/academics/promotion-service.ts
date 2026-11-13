/**
 * Moving students to the next academic year ("Move students to next year").
 *
 * After a year's results are finalized, the principal moves every student placed in a source-year
 * section into a target-year section. The preview proposes a destination from each student's CURRENT
 * annual result (the latest non-superseded finalization with no term):
 *
 *   promoted       -> the next grade by sort_order, the section with the same name (8A -> 9A)
 *   promoted, top  -> graduates: students.status becomes 'graduated', placed nowhere
 *   retained       -> the same grade, the section with the same name (8A -> 8A)
 *   supplementary  -> awaiting the resit: not moved; a corrected result changes the proposal
 *   incomplete / no annual result -> needs a decision; nothing is guessed
 *   no section of that name in the target year -> needs a decision
 *
 * Students who are withdrawn or archived are skipped; graduated students and students already placed
 * in the target year show as done, so re-running is safe. Applying writes nothing to the source
 * year: its placements, results, certificates and enrollments stay exactly as they were (class
 * enrollments of the old year are closed by the year rollover, as before). Placement goes through
 * placeStudentInSection, which enrolls the student into the target section's classes and writes the
 * audit row; graduation writes its own audit row.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { placeStudentInSection } from "./section-service";

import type { TransactionSql } from "postgres";

export type PromotionAction = "place" | "graduate" | "skip";

export type PromotionReason =
  | "promoted"
  | "retained"
  | "final_grade"
  | "awaiting_resit"
  | "incomplete_result"
  | "no_result"
  | "no_matching_section"
  | "already_placed"
  | "already_graduated"
  | "inactive_student";

export type AcademicStatus = "promoted" | "supplementary" | "retained" | "incomplete";

export interface PromotionYear {
  id: string;
  name: string;
  status: string;
}

export interface PromotionTargetSection {
  id: string;
  name: string;
  grade_level_id: string;
  grade_level_name: string;
  grade_sort_order: number;
  student_count: number;
}

export interface PromotionPreviewStudent {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  student_status: string;
  source_section_id: string;
  source_section_name: string;
  source_grade_level_id: string;
  source_grade_level_name: string;
  academic_status: AcademicStatus | null;
  average_percentage: number | null;
  proposed_action: PromotionAction;
  proposed_section_id: string | null;
  reason: PromotionReason;
  needs_decision: boolean;
  /** Already done in an earlier run: placed in a target-year section, or graduated. */
  done: "placed" | "graduated" | null;
  /** The target-year section the student is placed in already, if any. */
  placed_section_id: string | null;
}

export interface PromotionPreview {
  source_year: PromotionYear;
  target_year: PromotionYear;
  target_sections: PromotionTargetSection[];
  students: PromotionPreviewStudent[];
}

export interface PromotionDecision {
  student_id: string;
  action: PromotionAction;
  target_section_id?: string | null;
}

export type PromotionOutcomeKind =
  | "moved_up"
  | "retained"
  | "moved"
  | "already_placed"
  | "graduated"
  | "already_graduated"
  | "skipped"
  | "failed";

export interface PromotionOutcome {
  student_id: string;
  outcome: PromotionOutcomeKind;
  section_id: string | null;
  error: string | null;
}

/** Statuses of students who no longer attend: never moved. */
const INACTIVE_STATUSES = new Set(["withdrawn", "archived"]);

async function requireYears(
  tx: TransactionSql,
  schoolId: string,
  sourceYearId: string,
  targetYearId: string,
): Promise<{ source: PromotionYear; target: PromotionYear }> {
  if (sourceYearId === targetYearId) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "Choose a different year to move students into",
    );
  }
  const rows = await tx<PromotionYear[]>`
    SELECT id, name, status::text AS status
    FROM app.academic_years
    WHERE school_id = ${schoolId} AND id IN (${sourceYearId}, ${targetYearId})
  `;
  const source = rows.find((row) => row.id === sourceYearId);
  const target = rows.find((row) => row.id === targetYearId);
  if (!source || !target) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Academic year not found");
  }
  if (target.status === "closed" || target.status === "archived") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Students can only be moved into a planned or active year",
    );
  }
  return { source, target };
}

async function loadTargetSections(
  tx: TransactionSql,
  schoolId: string,
  targetYearId: string,
): Promise<PromotionTargetSection[]> {
  return tx<PromotionTargetSection[]>`
    SELECT sec.id, sec.name, sec.grade_level_id, gl.name AS grade_level_name,
           gl.sort_order AS grade_sort_order,
           (SELECT count(*)::int FROM app.student_sections AS ss
             WHERE ss.section_id = sec.id AND ss.school_id = sec.school_id) AS student_count
    FROM app.sections AS sec
    JOIN app.grade_levels AS gl ON gl.id = sec.grade_level_id AND gl.school_id = sec.school_id
    WHERE sec.school_id = ${schoolId} AND sec.academic_year_id = ${targetYearId}
      AND sec.archived_at IS NULL
    ORDER BY gl.sort_order, gl.name, sec.name
  `;
}

interface SourceRow {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  student_status: string;
  source_section_id: string;
  source_section_name: string;
  source_grade_level_id: string;
  source_grade_level_name: string;
  source_grade_sort_order: number;
  academic_status: AcademicStatus | null;
  average_percentage: string | null;
  placed_section_id: string | null;
}

async function loadSourceStudents(
  tx: TransactionSql,
  schoolId: string,
  sourceYearId: string,
  targetYearId: string,
  studentIds?: readonly string[],
): Promise<SourceRow[]> {
  const only = studentIds ? tx`AND ss.student_id = ANY(${studentIds as string[]}::uuid[])` : tx``;
  return tx<SourceRow[]>`
    WITH annual AS (
      SELECT DISTINCT ON (o.student_id)
             o.student_id, o.academic_status, o.average_percentage
      FROM app.student_overall_results AS o
      JOIN app.result_finalizations AS rf
        ON rf.id = o.finalization_id AND rf.school_id = o.school_id
      WHERE rf.school_id = ${schoolId} AND rf.academic_year_id = ${sourceYearId}
        AND rf.term_id IS NULL AND rf.status = 'finalized'
      ORDER BY o.student_id, rf.finalized_at DESC, rf.version DESC
    )
    SELECT s.id AS student_id, s.first_name, s.last_name, s.admission_number,
           s.status::text AS student_status,
           sec.id AS source_section_id, sec.name AS source_section_name,
           gl.id AS source_grade_level_id, gl.name AS source_grade_level_name,
           gl.sort_order AS source_grade_sort_order,
           annual.academic_status, annual.average_percentage::text AS average_percentage,
           target.section_id AS placed_section_id
    FROM app.student_sections AS ss
    JOIN app.students AS s ON s.id = ss.student_id AND s.school_id = ss.school_id
    JOIN app.sections AS sec ON sec.id = ss.section_id AND sec.school_id = ss.school_id
    JOIN app.grade_levels AS gl ON gl.id = sec.grade_level_id AND gl.school_id = sec.school_id
    LEFT JOIN annual ON annual.student_id = ss.student_id
    LEFT JOIN app.student_sections AS target
      ON target.student_id = ss.student_id AND target.school_id = ss.school_id
     AND target.academic_year_id = ${targetYearId}
    WHERE ss.school_id = ${schoolId} AND ss.academic_year_id = ${sourceYearId} ${only}
    ORDER BY gl.sort_order, gl.name, sec.name, s.last_name, s.first_name, s.id
  `;
}

interface GradeOrder {
  id: string;
  sort_order: number;
}

/** The grade after `sortOrder` (the lowest sort_order above it), or null for the top grade. */
function nextGradeId(grades: readonly GradeOrder[], sortOrder: number): string | null {
  let next: GradeOrder | null = null;
  for (const grade of grades) {
    if (grade.sort_order > sortOrder && (next === null || grade.sort_order < next.sort_order)) {
      next = grade;
    }
  }
  return next?.id ?? null;
}

function sectionKey(gradeLevelId: string, name: string): string {
  return `${gradeLevelId}\u0000${name.trim().toLowerCase()}`;
}

/** The proposal for one student: pure, so the mapping rules are tested on their own. */
export function proposeDestination(
  row: Pick<
    SourceRow,
    | "student_status"
    | "academic_status"
    | "source_section_name"
    | "source_grade_level_id"
    | "source_grade_sort_order"
    | "placed_section_id"
  >,
  grades: readonly GradeOrder[],
  sectionsByKey: ReadonlyMap<string, string>,
): Pick<
  PromotionPreviewStudent,
  "proposed_action" | "proposed_section_id" | "reason" | "needs_decision" | "done"
> {
  const skip = (reason: PromotionReason, needsDecision: boolean) => ({
    proposed_action: "skip" as const,
    proposed_section_id: null,
    reason,
    needs_decision: needsDecision,
    done: null,
  });

  if (row.student_status === "graduated") {
    return { ...skip("already_graduated", false), done: "graduated" };
  }
  if (INACTIVE_STATUSES.has(row.student_status)) return skip("inactive_student", false);
  if (row.placed_section_id) {
    return {
      proposed_action: "place",
      proposed_section_id: row.placed_section_id,
      reason: "already_placed",
      needs_decision: false,
      done: "placed",
    };
  }

  switch (row.academic_status) {
    case "promoted": {
      const next = nextGradeId(grades, row.source_grade_sort_order);
      if (next === null) {
        return {
          proposed_action: "graduate",
          proposed_section_id: null,
          reason: "final_grade",
          needs_decision: false,
          done: null,
        };
      }
      const section = sectionsByKey.get(sectionKey(next, row.source_section_name));
      if (!section) return skip("no_matching_section", true);
      return {
        proposed_action: "place",
        proposed_section_id: section,
        reason: "promoted",
        needs_decision: false,
        done: null,
      };
    }
    case "retained": {
      const section = sectionsByKey.get(
        sectionKey(row.source_grade_level_id, row.source_section_name),
      );
      if (!section) return skip("no_matching_section", true);
      return {
        proposed_action: "place",
        proposed_section_id: section,
        reason: "retained",
        needs_decision: false,
        done: null,
      };
    }
    case "supplementary":
      return skip("awaiting_resit", false);
    case "incomplete":
      return skip("incomplete_result", true);
    default:
      return skip("no_result", true);
  }
}

async function loadGrades(tx: TransactionSql, schoolId: string): Promise<GradeOrder[]> {
  return tx<GradeOrder[]>`
    SELECT id, sort_order FROM app.grade_levels WHERE school_id = ${schoolId}
  `;
}

export async function previewPromotion(
  tx: TransactionSql,
  schoolId: string,
  sourceYearId: string,
  targetYearId: string,
): Promise<PromotionPreview> {
  const { source, target } = await requireYears(tx, schoolId, sourceYearId, targetYearId);
  const [targetSections, rows, grades] = [
    await loadTargetSections(tx, schoolId, targetYearId),
    await loadSourceStudents(tx, schoolId, sourceYearId, targetYearId),
    await loadGrades(tx, schoolId),
  ];
  const sectionsByKey = new Map(
    targetSections.map((section) => [sectionKey(section.grade_level_id, section.name), section.id]),
  );

  return {
    source_year: source,
    target_year: target,
    target_sections: targetSections,
    students: rows.map((row) => ({
      student_id: row.student_id,
      first_name: row.first_name,
      last_name: row.last_name,
      admission_number: row.admission_number,
      student_status: row.student_status,
      source_section_id: row.source_section_id,
      source_section_name: row.source_section_name,
      source_grade_level_id: row.source_grade_level_id,
      source_grade_level_name: row.source_grade_level_name,
      academic_status: row.academic_status,
      average_percentage: row.average_percentage === null ? null : Number(row.average_percentage),
      placed_section_id: row.placed_section_id,
      ...proposeDestination(row, grades, sectionsByKey),
    })),
  };
}

/**
 * Apply the principal's decisions for a batch of students. Each student runs in its own savepoint,
 * so one refusal (an inactive student, a section from another year) is reported without undoing the
 * rest of the batch. Re-running the same decisions changes nothing and reports `already_*`.
 */
export async function applyPromotion(
  tx: TransactionSql,
  schoolId: string,
  sourceYearId: string,
  targetYearId: string,
  decisions: readonly PromotionDecision[],
): Promise<PromotionOutcome[]> {
  await requireYears(tx, schoolId, sourceYearId, targetYearId);
  const ids = [...new Set(decisions.map((decision) => decision.student_id))];
  if (ids.length !== decisions.length) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "Each student may appear only once in a batch",
    );
  }

  const rows = await loadSourceStudents(tx, schoolId, sourceYearId, targetYearId, ids);
  const byStudent = new Map(rows.map((row) => [row.student_id, row]));
  const targetSections = await loadTargetSections(tx, schoolId, targetYearId);
  const sectionsById = new Map(targetSections.map((section) => [section.id, section]));

  const outcomes: PromotionOutcome[] = [];
  for (const decision of decisions) {
    const row = byStudent.get(decision.student_id);
    const fail = (error: string): PromotionOutcome => ({
      student_id: decision.student_id,
      outcome: "failed",
      section_id: null,
      error,
    });
    if (!row) {
      outcomes.push(fail("not_in_source_year"));
      continue;
    }
    if (decision.action === "skip") {
      outcomes.push({
        student_id: row.student_id,
        outcome: "skipped",
        section_id: null,
        error: null,
      });
      continue;
    }

    if (decision.action === "graduate") {
      if (row.student_status === "graduated") {
        outcomes.push({
          student_id: row.student_id,
          outcome: "already_graduated",
          section_id: null,
          error: null,
        });
        continue;
      }
      if (INACTIVE_STATUSES.has(row.student_status)) {
        outcomes.push(fail("student_inactive"));
        continue;
      }
      if (row.placed_section_id) {
        outcomes.push(fail("placed_in_target_year"));
        continue;
      }
      await tx.savepoint(async (sp) => {
        await sp`
          UPDATE app.students
          SET status = 'graduated'::app.student_status, updated_at = CURRENT_TIMESTAMP
          WHERE id = ${row.student_id} AND school_id = ${schoolId}
        `;
        await emitAuditLog(sp, {
          action: "update",
          targetTable: "students",
          targetId: row.student_id,
          oldValues: { status: row.student_status },
          newValues: {
            status: "graduated",
            reason: "year_promotion",
            source_year_id: sourceYearId,
            target_year_id: targetYearId,
          },
        });
      });
      outcomes.push({
        student_id: row.student_id,
        outcome: "graduated",
        section_id: null,
        error: null,
      });
      continue;
    }

    // place
    const section = decision.target_section_id
      ? sectionsById.get(decision.target_section_id)
      : undefined;
    if (!section) {
      outcomes.push(fail("section_not_in_target_year"));
      continue;
    }
    if (row.student_status === "graduated" || INACTIVE_STATUSES.has(row.student_status)) {
      outcomes.push(fail("student_inactive"));
      continue;
    }
    if (row.placed_section_id === section.id) {
      outcomes.push({
        student_id: row.student_id,
        outcome: "already_placed",
        section_id: section.id,
        error: null,
      });
      continue;
    }
    await tx.savepoint((sp) =>
      placeStudentInSection(sp, schoolId, section.id, row.student_id, {
        reason: "year_promotion",
        source_year_id: sourceYearId,
        source_section_id: row.source_section_id,
      }),
    );
    const outcome: PromotionOutcomeKind =
      section.grade_sort_order > row.source_grade_sort_order
        ? "moved_up"
        : section.grade_level_id === row.source_grade_level_id
          ? "retained"
          : "moved";
    outcomes.push({ student_id: row.student_id, outcome, section_id: section.id, error: null });
  }
  return outcomes;
}
