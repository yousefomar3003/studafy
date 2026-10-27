import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { requireYear } from "./access";

import type { TransactionSql } from "postgres";

export interface CopyYearSummary {
  source_year_id: string;
  target_year_id: string;
  scales: number;
  grade_programs: number;
  sections_created: number;
  sections_reused: number;
  subject_configs: number;
  categories: number;
  assessments: number;
  teacher_assignments: number;
  /** What could not be carried over (e.g. a term with no counterpart in the new year). */
  warnings: string[];
}

/**
 * Start a new year from last year's set-up: grading scales, grade programs, sections (by grade and
 * name), every subject config with its categories, term weights and assessments, section overrides,
 * and optionally teacher assignments.
 *
 * Never copied: marks, mark sheets, results, certificates, student placements and electives — the
 * new year starts with no academic record. Terms are matched by sequence number; assessment dates
 * are cleared (they belong to the old calendar). The target year must still be a draft with no
 * grading configuration, and stays a draft so the administrator reviews it before publishing.
 */
export async function copyYearConfiguration(
  tx: TransactionSql,
  schoolId: string,
  sourceYearId: string,
  targetYearId: string,
  options: { includeTeacherAssignments: boolean },
): Promise<CopyYearSummary> {
  if (sourceYearId === targetYearId) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "Choose a different year to copy from",
    );
  }
  await requireYear(tx, schoolId, sourceYearId);
  const target = await requireYear(tx, schoolId, targetYearId);
  if (target.grading_config_status !== "draft") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Only a draft year can receive a copied configuration",
    );
  }
  const [existing] = await tx<{ count: number }[]>`
    SELECT (
      (SELECT count(*) FROM app.grade_programs WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${targetYearId}::uuid)
      + (SELECT count(*) FROM app.grade_scales WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${targetYearId}::uuid)
    )::int AS count
  `;
  if ((existing?.count ?? 0) > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "This year already has a grading configuration; copying would mix two set-ups",
    );
  }

  const summary: CopyYearSummary = {
    source_year_id: sourceYearId,
    target_year_id: targetYearId,
    scales: 0,
    grade_programs: 0,
    sections_created: 0,
    sections_reused: 0,
    subject_configs: 0,
    categories: 0,
    assessments: 0,
    teacher_assignments: 0,
    warnings: [],
  };

  // Terms map by sequence number.
  const termRows = await tx<
    { id: string; academic_year_id: string; sequence_number: number; name: string }[]
  >`
    SELECT id, academic_year_id, sequence_number, name FROM app.terms
    WHERE school_id = ${schoolId}::uuid AND academic_year_id IN (${sourceYearId}::uuid, ${targetYearId}::uuid)
  `;
  const termMap = new Map<string, string>();
  for (const term of termRows.filter((t) => t.academic_year_id === sourceYearId)) {
    const match = termRows.find(
      (t) => t.academic_year_id === targetYearId && t.sequence_number === term.sequence_number,
    );
    if (match) termMap.set(term.id, match.id);
    else
      summary.warnings.push(
        `${term.name} has no matching term in the new year; its weights and assessments were not copied.`,
      );
  }

  // Scales.
  const scaleMap = new Map<string, string>();
  const scales = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM app.grade_scales WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${sourceYearId}::uuid
  `;
  for (const scale of scales) {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_scales (school_id, academic_year_id, name)
      VALUES (${schoolId}::uuid, ${targetYearId}::uuid, ${scale.name}) RETURNING id
    `;
    await tx`
      INSERT INTO app.grade_scale_bands (school_id, grade_scale_id, label, min_percentage, gpa_points)
      SELECT school_id, ${row!.id}::uuid, label, min_percentage, gpa_points
      FROM app.grade_scale_bands WHERE school_id = ${schoolId}::uuid AND grade_scale_id = ${scale.id}::uuid
    `;
    scaleMap.set(scale.id, row!.id);
    summary.scales += 1;
  }
  const mapScale = (id: string | null) => (id ? (scaleMap.get(id) ?? null) : null);

  // Programs.
  const programs = await tx<
    {
      grade_level_id: string;
      grade_scale_id: string | null;
      max_failed_subjects_for_supplementary: number;
      mark_approval_required: boolean;
      average_rounding_decimals: number;
      average_rounding_mode: string;
    }[]
  >`
    SELECT grade_level_id, grade_scale_id, max_failed_subjects_for_supplementary,
           mark_approval_required, average_rounding_decimals, average_rounding_mode
    FROM app.grade_programs WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${sourceYearId}::uuid
  `;
  for (const program of programs) {
    await tx`
      INSERT INTO app.grade_programs (
        school_id, academic_year_id, grade_level_id, grade_scale_id,
        max_failed_subjects_for_supplementary, mark_approval_required,
        average_rounding_decimals, average_rounding_mode
      ) VALUES (
        ${schoolId}::uuid, ${targetYearId}::uuid, ${program.grade_level_id}::uuid,
        ${mapScale(program.grade_scale_id)}::uuid, ${program.max_failed_subjects_for_supplementary},
        ${program.mark_approval_required}, ${program.average_rounding_decimals},
        ${program.average_rounding_mode}
      )
    `;
    summary.grade_programs += 1;
  }

  // Sections, matched by grade and name.
  const sourceSections = await tx<{ id: string; grade_level_id: string; name: string }[]>`
    SELECT id, grade_level_id, name FROM app.sections
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${sourceYearId}::uuid AND archived_at IS NULL
  `;
  const sectionMap = new Map<string, string>();
  for (const section of sourceSections) {
    const [found] = await tx<{ id: string }[]>`
      SELECT id FROM app.sections
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${targetYearId}::uuid
        AND grade_level_id = ${section.grade_level_id}::uuid AND name = ${section.name}
    `;
    if (found) {
      sectionMap.set(section.id, found.id);
      summary.sections_reused += 1;
    } else {
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
        VALUES (${schoolId}::uuid, ${targetYearId}::uuid, ${section.grade_level_id}::uuid, ${section.name})
        RETURNING id
      `;
      sectionMap.set(section.id, created!.id);
      summary.sections_created += 1;
    }
  }

  // Subject configs: grade defaults first (overrides point at their revision).
  const configs = await tx<
    ({ id: string; section_id: string | null; grade_scale_id: string | null } & Record<
      string,
      unknown
    >)[]
  >`
    SELECT * FROM app.subject_configs
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${sourceYearId}::uuid
    ORDER BY section_id NULLS FIRST
  `;
  for (const config of configs) {
    if (config.section_id !== null && !sectionMap.has(config.section_id)) continue;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.subject_configs (
        school_id, academic_year_id, grade_level_id, section_id, subject_id, requirement,
        include_in_average, include_on_certificate, average_weight, grading_method, max_marks,
        pass_percentage, final_exam_pass_percentage, grade_scale_id, rounding_decimals,
        rounding_mode, missing_mark_policy, absent_policy, retake_policy, retake_cap_percentage,
        teachers_can_add_assessments, teacher_assessments_require_approval, instructions,
        is_excluded, based_on_revision
      )
      SELECT school_id, ${targetYearId}::uuid, grade_level_id,
             ${config.section_id ? sectionMap.get(config.section_id)! : null}::uuid, subject_id,
             requirement, include_in_average, include_on_certificate, average_weight,
             grading_method, max_marks, pass_percentage, final_exam_pass_percentage,
             ${mapScale(config.grade_scale_id)}::uuid, rounding_decimals, rounding_mode,
             missing_mark_policy, absent_policy, retake_policy, retake_cap_percentage,
             teachers_can_add_assessments, teacher_assessments_require_approval, instructions,
             is_excluded, CASE WHEN section_id IS NULL THEN NULL ELSE 1 END
      FROM app.subject_configs WHERE id = ${config.id}::uuid AND school_id = ${schoolId}::uuid
      RETURNING id
    `;
    const newConfigId = row!.id;
    summary.subject_configs += 1;

    const categoryMap = new Map<string, string>();
    const categories = await tx<{ id: string }[]>`
      SELECT id FROM app.subject_config_categories WHERE school_id = ${schoolId}::uuid AND subject_config_id = ${config.id}::uuid
    `;
    for (const category of categories) {
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO app.subject_config_categories
          (school_id, subject_config_id, name, kind, scope, weight, aggregation, drop_lowest, sort_order)
        SELECT school_id, ${newConfigId}::uuid, name, kind, scope, weight, aggregation, drop_lowest, sort_order
        FROM app.subject_config_categories WHERE id = ${category.id}::uuid AND school_id = ${schoolId}::uuid
        RETURNING id
      `;
      categoryMap.set(category.id, created!.id);
      summary.categories += 1;
    }

    const weights = await tx<{ term_id: string; weight: string }[]>`
      SELECT term_id, weight FROM app.subject_config_term_weights
      WHERE school_id = ${schoolId}::uuid AND subject_config_id = ${config.id}::uuid
    `;
    for (const weight of weights) {
      const term = termMap.get(weight.term_id);
      if (!term) continue;
      await tx`
        INSERT INTO app.subject_config_term_weights (school_id, subject_config_id, academic_year_id, term_id, weight)
        VALUES (${schoolId}::uuid, ${newConfigId}::uuid, ${targetYearId}::uuid, ${term}::uuid, ${weight.weight})
      `;
    }

    const assessments = await tx<
      {
        category_id: string;
        term_id: string | null;
        section_id: string | null;
        name: string;
        max_marks: string;
        weight: string;
        is_mandatory: boolean;
        sort_order: number;
      }[]
    >`
      SELECT category_id, term_id, section_id, name, max_marks, weight, is_mandatory, sort_order
      FROM app.subject_config_assessments
      WHERE school_id = ${schoolId}::uuid AND subject_config_id = ${config.id}::uuid AND status = 'active'
    `;
    for (const assessment of assessments) {
      if (assessment.term_id !== null && !termMap.has(assessment.term_id)) continue;
      if (assessment.section_id !== null && !sectionMap.has(assessment.section_id)) continue;
      await tx`
        INSERT INTO app.subject_config_assessments (
          school_id, subject_config_id, academic_year_id, category_id, term_id, section_id, name,
          max_marks, weight, is_mandatory, status, sort_order
        ) VALUES (
          ${schoolId}::uuid, ${newConfigId}::uuid, ${targetYearId}::uuid,
          ${categoryMap.get(assessment.category_id)!}::uuid,
          ${assessment.term_id ? termMap.get(assessment.term_id)! : null}::uuid,
          ${assessment.section_id ? sectionMap.get(assessment.section_id)! : null}::uuid,
          ${assessment.name}, ${assessment.max_marks}, ${assessment.weight},
          ${assessment.is_mandatory}, 'active', ${assessment.sort_order}
        )
      `;
      summary.assessments += 1;
    }
  }

  if (options.includeTeacherAssignments) {
    const assignments = await tx<{ section_id: string; subject_id: string; teacher_id: string }[]>`
      SELECT assignment.section_id, assignment.subject_id, assignment.teacher_id
      FROM app.section_subject_teachers AS assignment
      JOIN app.teachers AS teacher ON teacher.id = assignment.teacher_id AND teacher.school_id = assignment.school_id
      WHERE assignment.school_id = ${schoolId}::uuid AND assignment.academic_year_id = ${sourceYearId}::uuid
        AND teacher.employment_status = 'active'
    `;
    for (const assignment of assignments) {
      const section = sectionMap.get(assignment.section_id);
      if (!section) continue;
      await tx`
        INSERT INTO app.section_subject_teachers (school_id, academic_year_id, section_id, subject_id, teacher_id)
        VALUES (${schoolId}::uuid, ${targetYearId}::uuid, ${section}::uuid, ${assignment.subject_id}::uuid,
                ${assignment.teacher_id}::uuid)
        ON CONFLICT DO NOTHING
      `;
      summary.teacher_assignments += 1;
    }
  }

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "subject_configs",
    targetId: targetYearId,
    newValues: { copied_from_year_id: sourceYearId, ...summary },
  });
  return summary;
}
