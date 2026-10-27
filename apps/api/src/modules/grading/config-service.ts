import { ERROR_CODES } from "@studafy/constants";
import {
  hasErrors,
  summarizeWeights,
  validateGradeScale,
  validateSubjectConfig,
} from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { assertConfigEditable, requireYear } from "./access";
import {
  loadConfigDetail,
  loadScale,
  loadYearTerms,
  requireConfig,
  requireProgram,
  requireSectionRow,
  resolveSectionSubjects,
  toEngineConfig,
} from "./engine-config";

import type { GradingConfigStatus, YearRow } from "./access";
import type {
  AssessmentRow,
  CategoryRow,
  LoadedConfig,
  ProgramRow,
  SectionRow,
  SubjectConfigRow,
  TermRow,
} from "./engine-config";
import type {
  CategoryAggregation,
  CategoryKind,
  CategoryScope,
  GradeBand,
  RoundingMode,
  SubjectGradingConfig,
  SubjectRequirement,
  ValidationIssue,
  WeightSummary,
} from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Input types (validated by the route schemas)
// ---------------------------------------------------------------------------

export interface ScaleInput {
  name: string;
  bands: { label: string; min_percentage: number; gpa_points: number | null }[];
}

export interface ProgramInput {
  grade_scale_id?: string | null;
  max_failed_subjects_for_supplementary?: number;
  mark_approval_required?: boolean;
  average_rounding_decimals?: number;
  average_rounding_mode?: RoundingMode;
}

export interface CategoryInput {
  /** An existing category id to keep, or a client-chosen key for a new category. */
  ref: string;
  name: string;
  kind: CategoryKind;
  scope: CategoryScope;
  weight: number | null;
  aggregation: CategoryAggregation;
  drop_lowest: number;
  sort_order: number;
}

export interface AssessmentInput {
  /** An existing assessment id to keep (its marks stay attached); omitted for a new one. */
  id?: string;
  category_ref: string;
  term_id: string | null;
  name: string;
  max_marks: number;
  weight: number;
  is_mandatory: boolean;
  assessment_date: string | null;
  due_date: string | null;
  sort_order: number;
}

export interface SubjectConfigInput {
  requirement: SubjectRequirement;
  include_in_average: boolean;
  include_on_certificate: boolean;
  average_weight: number;
  grading_method: "weighted" | "total_points";
  max_marks: number;
  pass_percentage: number;
  final_exam_pass_percentage: number | null;
  grade_scale_id: string | null;
  rounding_decimals: number;
  rounding_mode: RoundingMode;
  missing_mark_policy: "incomplete" | "zero";
  absent_policy: "incomplete" | "zero";
  retake_policy: "none" | "replace" | "highest" | "capped";
  retake_cap_percentage: number | null;
  teachers_can_add_assessments: boolean;
  teacher_assessments_require_approval: boolean;
  instructions: string | null;
  term_weights: { term_id: string; weight: number }[];
  categories: CategoryInput[];
  assessments: AssessmentInput[];
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ScaleView {
  id: string;
  academic_year_id: string;
  name: string;
  bands: { label: string; min_percentage: number; gpa_points: number | null }[];
  issues: ValidationIssue[];
}

export interface ConfigView {
  id: string;
  academic_year_id: string;
  grade_level_id: string;
  section_id: string | null;
  subject: { id: string; code: string; name: string };
  requirement: SubjectRequirement;
  include_in_average: boolean;
  include_on_certificate: boolean;
  average_weight: number;
  grading_method: "weighted" | "total_points";
  max_marks: number;
  pass_percentage: number;
  final_exam_pass_percentage: number | null;
  grade_scale_id: string | null;
  effective_scale_name: string | null;
  rounding_decimals: number;
  rounding_mode: RoundingMode;
  missing_mark_policy: "incomplete" | "zero";
  absent_policy: "incomplete" | "zero";
  retake_policy: "none" | "replace" | "highest" | "capped";
  retake_cap_percentage: number | null;
  teachers_can_add_assessments: boolean;
  teacher_assessments_require_approval: boolean;
  instructions: string | null;
  is_excluded: boolean;
  revision: number;
  based_on_revision: number | null;
  term_weights: { term_id: string; term_name: string; sequence_number: number; weight: number }[];
  categories: {
    id: string;
    name: string;
    kind: CategoryKind;
    scope: CategoryScope;
    weight: number | null;
    aggregation: CategoryAggregation;
    drop_lowest: number;
    sort_order: number;
  }[];
  assessments: {
    id: string;
    category_id: string;
    term_id: string | null;
    section_id: string | null;
    name: string;
    max_marks: number;
    weight: number;
    is_mandatory: boolean;
    assessment_date: string | null;
    due_date: string | null;
    status: "active" | "proposed" | "rejected";
    sort_order: number;
    mark_count: number;
  }[];
  weight_summary: WeightSummary;
  issues: ValidationIssue[];
  valid: boolean;
  mark_count: number;
  updated_at: string;
}

export interface SaveResult {
  config: ConfigView;
  /** Sections whose effective configuration changed with this save. */
  affected_section_ids: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalid(issues: ValidationIssue[]): never {
  const errors = issues.filter((issue) => issue.severity === "error");
  throw new CodedHttpException(
    400,
    ERROR_CODES.ACADEMIC_CONFIG_INVALID,
    `The grading configuration is not valid: ${errors.map((issue) => issue.message).join(" ")}`,
  );
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === code;
}

/** The engine's view of an unsaved input, using category refs and positional assessment ids. */
function inputToEngine(
  input: SubjectConfigInput,
  terms: TermRow[],
  scale: GradeBand[],
): SubjectGradingConfig {
  const weights = new Map(input.term_weights.map((row) => [row.term_id, row.weight]));
  return {
    method: input.grading_method,
    maxMarks: input.max_marks,
    passPercentage: input.pass_percentage,
    finalExamPassPercentage: input.final_exam_pass_percentage,
    rounding: { decimals: input.rounding_decimals, mode: input.rounding_mode },
    missingPolicy: input.missing_mark_policy,
    absentPolicy: input.absent_policy,
    retakePolicy: input.retake_policy,
    retakeCapPercentage: input.retake_cap_percentage,
    scale,
    terms: terms.map((term) => ({
      termId: term.id,
      name: term.name,
      sequence: term.sequence_number,
      weight: weights.get(term.id) ?? 0,
    })),
    categories: input.categories.map((category) => ({
      id: category.ref,
      name: category.name,
      kind: category.kind,
      scope: category.scope,
      weight: category.weight,
      aggregation: category.aggregation,
      dropLowest: category.drop_lowest,
    })),
    assessments: input.assessments.map((assessment, index) => ({
      id: assessment.id ?? `new-${index}`,
      categoryId: assessment.category_ref,
      termId: assessment.term_id,
      name: assessment.name,
      maxMarks: assessment.max_marks,
      weight: assessment.weight,
      mandatory: assessment.is_mandatory,
    })),
  };
}

function checkInputReferences(input: SubjectConfigInput, terms: TermRow[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const termIds = new Set(terms.map((term) => term.id));
  for (const weight of input.term_weights) {
    if (!termIds.has(weight.term_id)) {
      issues.push({
        code: "TERM_UNKNOWN",
        severity: "error",
        message: "A term weight refers to a term outside this academic year.",
        ref: weight.term_id,
      });
    }
  }
  const refs = new Set<string>();
  for (const category of input.categories) {
    if (refs.has(category.ref)) {
      issues.push({
        code: "DUPLICATE_CATEGORY_REF",
        severity: "error",
        message: `Category reference "${category.ref}" is used twice.`,
        ref: category.ref,
      });
    }
    refs.add(category.ref);
  }
  const ids = new Set<string>();
  for (const assessment of input.assessments) {
    if (assessment.id) {
      if (ids.has(assessment.id)) {
        issues.push({
          code: "DUPLICATE_ASSESSMENT_ID",
          severity: "error",
          message: `Assessment "${assessment.name}" is listed twice.`,
          ref: assessment.id,
        });
      }
      ids.add(assessment.id);
    }
  }
  return issues;
}

/**
 * The parts of a configuration that change how marks turn into grades. Names, dates, instructions
 * and display order are left out: editing those never needs an impact review.
 */
function gradingSignature(engine: SubjectGradingConfig, flags: Record<string, unknown>): string {
  return JSON.stringify({
    ...flags,
    method: engine.method,
    maxMarks: engine.maxMarks,
    pass: engine.passPercentage,
    final: engine.finalExamPassPercentage,
    rounding: engine.rounding,
    policies: [
      engine.missingPolicy,
      engine.absentPolicy,
      engine.retakePolicy,
      engine.retakeCapPercentage,
    ],
    terms: engine.terms.map((term) => [term.termId, term.weight]),
    categories: engine.categories
      .map((c) => [c.id, c.kind, c.scope, c.weight, c.aggregation, c.dropLowest])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    assessments: engine.assessments
      .map((a) => [a.id, a.categoryId, a.termId, a.maxMarks, a.weight, a.mandatory])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
}

function signatureFlags(source: {
  requirement: string;
  include_in_average: boolean;
  include_on_certificate: boolean;
  average_weight: number | string;
  grade_scale_id: string | null;
}): Record<string, unknown> {
  return {
    requirement: source.requirement,
    include_in_average: source.include_in_average,
    include_on_certificate: source.include_on_certificate,
    average_weight: Number(source.average_weight),
    grade_scale_id: source.grade_scale_id,
  };
}

async function markCounts(
  tx: TransactionSql,
  schoolId: string,
  assessmentIds: string[],
): Promise<Map<string, number>> {
  if (assessmentIds.length === 0) return new Map();
  const rows = await tx<{ assessment_id: string; count: number; max_score: string | null }[]>`
    SELECT assessment_id, count(*)::int AS count, max(score)::text AS max_score
    FROM app.student_marks
    WHERE school_id = ${schoolId}::uuid AND assessment_id = ANY (${assessmentIds}::uuid[])
    GROUP BY assessment_id
  `;
  return new Map(rows.map((row) => [row.assessment_id, row.count]));
}

async function maxScores(
  tx: TransactionSql,
  schoolId: string,
  assessmentIds: string[],
): Promise<Map<string, number>> {
  if (assessmentIds.length === 0) return new Map();
  const rows = await tx<{ assessment_id: string; max_score: string }[]>`
    SELECT assessment_id, max(score)::text AS max_score
    FROM app.student_marks
    WHERE school_id = ${schoolId}::uuid
      AND assessment_id = ANY (${assessmentIds}::uuid[])
      AND score IS NOT NULL
    GROUP BY assessment_id
  `;
  return new Map(rows.map((row) => [row.assessment_id, Number(row.max_score)]));
}

// ---------------------------------------------------------------------------
// Grading scales
// ---------------------------------------------------------------------------

function toScaleView(id: string, yearId: string, name: string, bands: GradeBand[]): ScaleView {
  return {
    id,
    academic_year_id: yearId,
    name,
    bands: bands.map((band) => ({
      label: band.label,
      min_percentage: band.minPercentage,
      gpa_points: band.gpaPoints,
    })),
    issues: validateGradeScale(bands),
  };
}

export async function listScales(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<ScaleView[]> {
  await requireYear(tx, schoolId, yearId);
  const scales = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM app.grade_scales
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
    ORDER BY name
  `;
  const views: ScaleView[] = [];
  for (const scale of scales) {
    const { bands } = await loadScale(tx, schoolId, scale.id);
    views.push(toScaleView(scale.id, yearId, scale.name, bands));
  }
  return views;
}

function bandsFromInput(input: ScaleInput): GradeBand[] {
  return input.bands.map((band) => ({
    label: band.label,
    minPercentage: band.min_percentage,
    gpaPoints: band.gpa_points,
  }));
}

async function writeBands(
  tx: TransactionSql,
  schoolId: string,
  scaleId: string,
  bands: GradeBand[],
): Promise<void> {
  await tx`DELETE FROM app.grade_scale_bands WHERE school_id = ${schoolId}::uuid AND grade_scale_id = ${scaleId}::uuid`;
  for (const band of bands) {
    await tx`
      INSERT INTO app.grade_scale_bands (school_id, grade_scale_id, label, min_percentage, gpa_points)
      VALUES (${schoolId}::uuid, ${scaleId}::uuid, ${band.label}, ${band.minPercentage},
              ${band.gpaPoints})
    `;
  }
}

export async function createScale(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  input: ScaleInput,
): Promise<ScaleView> {
  assertConfigEditable(await requireYear(tx, schoolId, yearId));
  const bands = bandsFromInput(input);
  const issues = validateGradeScale(bands);
  if (hasErrors(issues)) invalid(issues);

  const [scale] = await tx<{ id: string }[]>`
    INSERT INTO app.grade_scales (school_id, academic_year_id, name)
    VALUES (${schoolId}::uuid, ${yearId}::uuid, ${input.name})
    RETURNING id
  `;
  await writeBands(tx, schoolId, scale!.id, bands);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "grade_scales",
    targetId: scale!.id,
    newValues: { academic_year_id: yearId, name: input.name, bands: input.bands },
  });
  return toScaleView(scale!.id, yearId, input.name, bands);
}

export async function updateScale(
  tx: TransactionSql,
  schoolId: string,
  scaleId: string,
  input: ScaleInput,
): Promise<ScaleView> {
  const [scale] = await tx<{ id: string; academic_year_id: string; name: string }[]>`
    SELECT id, academic_year_id, name FROM app.grade_scales
    WHERE id = ${scaleId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!scale) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Grading scale not found");
  }
  assertConfigEditable(await requireYear(tx, schoolId, scale.academic_year_id));
  const bands = bandsFromInput(input);
  const issues = validateGradeScale(bands);
  if (hasErrors(issues)) invalid(issues);

  const before = await loadScale(tx, schoolId, scaleId);
  await tx`
    UPDATE app.grade_scales SET name = ${input.name}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${scaleId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await writeBands(tx, schoolId, scaleId, bands);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_scales",
    targetId: scaleId,
    oldValues: { name: scale.name, bands: before.bands },
    newValues: { name: input.name, bands: input.bands },
  });
  return toScaleView(scaleId, scale.academic_year_id, input.name, bands);
}

export async function deleteScale(
  tx: TransactionSql,
  schoolId: string,
  scaleId: string,
): Promise<void> {
  const [scale] = await tx<{ academic_year_id: string }[]>`
    SELECT academic_year_id FROM app.grade_scales
    WHERE id = ${scaleId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!scale) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Grading scale not found");
  }
  assertConfigEditable(await requireYear(tx, schoolId, scale.academic_year_id));
  try {
    await tx.savepoint(
      (sp) =>
        sp`DELETE FROM app.grade_scales WHERE id = ${scaleId}::uuid AND school_id = ${schoolId}::uuid`,
    );
  } catch (error) {
    if (isPgError(error, "23503")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CONFLICT_STATE_MISMATCH,
        "This grading scale is still used by a grade or subject",
      );
    }
    throw error;
  }
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "grade_scales",
    targetId: scaleId,
    oldValues: { academic_year_id: scale.academic_year_id },
  });
}

// ---------------------------------------------------------------------------
// Grade programs
// ---------------------------------------------------------------------------

export async function listPrograms(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<ProgramRow[]> {
  await requireYear(tx, schoolId, yearId);
  return tx<ProgramRow[]>`
    SELECT program.id, program.academic_year_id, program.grade_level_id,
           grade.name AS grade_level_name, program.grade_scale_id,
           program.max_failed_subjects_for_supplementary, program.mark_approval_required,
           program.average_rounding_decimals, program.average_rounding_mode, program.updated_at
    FROM app.grade_programs AS program
    JOIN app.grade_levels AS grade
      ON grade.id = program.grade_level_id AND grade.school_id = program.school_id
    WHERE program.school_id = ${schoolId}::uuid AND program.academic_year_id = ${yearId}::uuid
    ORDER BY grade.sort_order, grade.name
  `;
}

/** Sets up a grade for a year (or updates its policies). Idempotent per grade and year. */
export async function upsertProgram(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  gradeLevelId: string,
  input: ProgramInput,
): Promise<ProgramRow> {
  assertConfigEditable(await requireYear(tx, schoolId, yearId));
  const [grade] = await tx<{ id: string; archived_at: Date | null }[]>`
    SELECT id, archived_at FROM app.grade_levels
    WHERE id = ${gradeLevelId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!grade)
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Grade level not found");

  const [existing] = await tx<ProgramRow[]>`
    SELECT id, grade_scale_id, max_failed_subjects_for_supplementary, mark_approval_required,
           average_rounding_decimals, average_rounding_mode
    FROM app.grade_programs
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
      AND grade_level_id = ${gradeLevelId}::uuid
  `;

  const scaleId =
    input.grade_scale_id === undefined ? (existing?.grade_scale_id ?? null) : input.grade_scale_id;
  if (scaleId) {
    const [scale] = await tx<{ id: string }[]>`
      SELECT id FROM app.grade_scales
      WHERE id = ${scaleId}::uuid AND school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
    `;
    if (!scale) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        "The grading scale must belong to the same academic year",
      );
    }
  }

  const values = {
    grade_scale_id: scaleId,
    max_failed_subjects_for_supplementary:
      input.max_failed_subjects_for_supplementary ??
      existing?.max_failed_subjects_for_supplementary ??
      0,
    mark_approval_required:
      input.mark_approval_required ?? existing?.mark_approval_required ?? true,
    average_rounding_decimals:
      input.average_rounding_decimals ?? existing?.average_rounding_decimals ?? 2,
    average_rounding_mode:
      input.average_rounding_mode ?? existing?.average_rounding_mode ?? "half_up",
  };

  if (existing) {
    await tx`
      UPDATE app.grade_programs SET
        grade_scale_id = ${values.grade_scale_id}::uuid,
        max_failed_subjects_for_supplementary = ${values.max_failed_subjects_for_supplementary},
        mark_approval_required = ${values.mark_approval_required},
        average_rounding_decimals = ${values.average_rounding_decimals},
        average_rounding_mode = ${values.average_rounding_mode},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${existing.id}::uuid AND school_id = ${schoolId}::uuid
    `;
  } else {
    await tx`
      INSERT INTO app.grade_programs (
        school_id, academic_year_id, grade_level_id, grade_scale_id,
        max_failed_subjects_for_supplementary, mark_approval_required,
        average_rounding_decimals, average_rounding_mode
      ) VALUES (
        ${schoolId}::uuid, ${yearId}::uuid, ${gradeLevelId}::uuid, ${values.grade_scale_id}::uuid,
        ${values.max_failed_subjects_for_supplementary}, ${values.mark_approval_required},
        ${values.average_rounding_decimals}, ${values.average_rounding_mode}
      )
    `;
  }
  const program = await requireProgram(tx, schoolId, yearId, gradeLevelId);
  await emitAuditLog(tx, {
    action: existing ? "update" : "insert",
    targetTable: "grade_programs",
    targetId: program.id,
    oldValues: existing ? { ...existing } : undefined,
    newValues: values,
  });
  return program;
}

// ---------------------------------------------------------------------------
// Subject configs: read
// ---------------------------------------------------------------------------

export async function toConfigView(
  tx: TransactionSql,
  schoolId: string,
  loaded: LoadedConfig,
): Promise<ConfigView> {
  const { config } = loaded;
  const engine = toEngineConfig(loaded);
  const issues = config.is_excluded ? [] : validateSubjectConfig(engine);
  const counts = await markCounts(
    tx,
    schoolId,
    loaded.assessments.map((assessment) => assessment.id),
  );
  const termById = new Map(loaded.terms.map((term) => [term.id, term]));
  return {
    id: config.id,
    academic_year_id: config.academic_year_id,
    grade_level_id: config.grade_level_id,
    section_id: config.section_id,
    subject: { id: config.subject_id, code: config.subject_code, name: config.subject_name },
    requirement: config.requirement,
    include_in_average: config.include_in_average,
    include_on_certificate: config.include_on_certificate,
    average_weight: Number(config.average_weight),
    grading_method: config.grading_method,
    max_marks: Number(config.max_marks),
    pass_percentage: Number(config.pass_percentage),
    final_exam_pass_percentage:
      config.final_exam_pass_percentage === null ? null : Number(config.final_exam_pass_percentage),
    grade_scale_id: config.grade_scale_id,
    effective_scale_name: loaded.scaleName,
    rounding_decimals: config.rounding_decimals,
    rounding_mode: config.rounding_mode,
    missing_mark_policy: config.missing_mark_policy,
    absent_policy: config.absent_policy,
    retake_policy: config.retake_policy,
    retake_cap_percentage:
      config.retake_cap_percentage === null ? null : Number(config.retake_cap_percentage),
    teachers_can_add_assessments: config.teachers_can_add_assessments,
    teacher_assessments_require_approval: config.teacher_assessments_require_approval,
    instructions: config.instructions,
    is_excluded: config.is_excluded,
    revision: config.revision,
    based_on_revision: config.based_on_revision,
    term_weights: loaded.termWeights
      .filter((row) => termById.has(row.term_id))
      .map((row) => ({
        term_id: row.term_id,
        term_name: termById.get(row.term_id)!.name,
        sequence_number: termById.get(row.term_id)!.sequence_number,
        weight: Number(row.weight),
      }))
      .sort((a, b) => a.sequence_number - b.sequence_number),
    categories: loaded.categories.map((category) => ({
      id: category.id,
      name: category.name,
      kind: category.kind,
      scope: category.scope,
      weight: category.weight === null ? null : Number(category.weight),
      aggregation: category.aggregation,
      drop_lowest: category.drop_lowest,
      sort_order: category.sort_order,
    })),
    assessments: loaded.assessments.map((assessment) => ({
      id: assessment.id,
      category_id: assessment.category_id,
      term_id: assessment.term_id,
      section_id: assessment.section_id,
      name: assessment.name,
      max_marks: Number(assessment.max_marks),
      weight: Number(assessment.weight),
      is_mandatory: assessment.is_mandatory,
      assessment_date: assessment.assessment_date,
      due_date: assessment.due_date,
      status: assessment.status,
      sort_order: assessment.sort_order,
      mark_count: counts.get(assessment.id) ?? 0,
    })),
    weight_summary: summarizeWeights(engine),
    issues,
    valid: !hasErrors(issues),
    mark_count: [...counts.values()].reduce((total, count) => total + count, 0),
    updated_at: config.updated_at.toISOString(),
  };
}

export async function getConfigView(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
): Promise<ConfigView> {
  return toConfigView(tx, schoolId, await loadConfigDetail(tx, schoolId, configId));
}

export async function listGradeConfigs(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  gradeLevelId: string,
): Promise<ConfigView[]> {
  await requireProgram(tx, schoolId, yearId, gradeLevelId);
  const rows = await tx<{ id: string }[]>`
    SELECT config.id
    FROM app.subject_configs AS config
    JOIN app.subjects AS subject ON subject.id = config.subject_id AND subject.school_id = config.school_id
    WHERE config.school_id = ${schoolId}::uuid AND config.academic_year_id = ${yearId}::uuid
      AND config.grade_level_id = ${gradeLevelId}::uuid AND config.section_id IS NULL
    ORDER BY subject.name
  `;
  const views: ConfigView[] = [];
  for (const row of rows) views.push(await getConfigView(tx, schoolId, row.id));
  return views;
}

export interface ConfigSummary {
  config_id: string;
  grade_level_id: string;
  section_id: string | null;
  subject_id: string;
  subject_name: string;
  requirement: SubjectRequirement;
  valid: boolean;
  error_count: number;
  warning_count: number;
  term_category_total: number;
  annual_total: number;
  revision: number;
}

/** Validation status of every subject config in a year, for dashboards. */
export async function listConfigSummaries(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<ConfigSummary[]> {
  const rows = await tx<{ id: string; is_excluded: boolean }[]>`
    SELECT config.id, config.is_excluded
    FROM app.subject_configs AS config
    JOIN app.subjects AS subject ON subject.id = config.subject_id AND subject.school_id = config.school_id
    WHERE config.school_id = ${schoolId}::uuid AND config.academic_year_id = ${yearId}::uuid
    ORDER BY subject.name
  `;
  const summaries: ConfigSummary[] = [];
  for (const row of rows) {
    if (row.is_excluded) continue;
    const loaded = await loadConfigDetail(tx, schoolId, row.id);
    const engine = toEngineConfig(loaded);
    const issues = validateSubjectConfig(engine);
    const weights = summarizeWeights(engine);
    summaries.push({
      config_id: row.id,
      grade_level_id: loaded.config.grade_level_id,
      section_id: loaded.config.section_id,
      subject_id: loaded.config.subject_id,
      subject_name: loaded.config.subject_name,
      requirement: loaded.config.requirement,
      valid: !hasErrors(issues),
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: issues.filter((issue) => issue.severity === "warning").length,
      term_category_total: weights.termCategoryTotal,
      annual_total: weights.annualTotal,
      revision: loaded.config.revision,
    });
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Subject configs: write
// ---------------------------------------------------------------------------

/** Apply categories, assessments and term weights to a config row, keeping ids the input names. */
async function writeStructure(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  config: SubjectConfigRow,
  input: SubjectConfigInput,
  existing: { categories: CategoryRow[]; assessments: AssessmentRow[] },
): Promise<void> {
  const existingCategoryIds = new Set(existing.categories.map((category) => category.id));
  const existingAssessmentIds = new Set(existing.assessments.map((assessment) => assessment.id));

  for (const assessment of input.assessments) {
    if (assessment.id && !existingAssessmentIds.has(assessment.id)) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Assessment ${assessment.id} does not belong to this subject configuration`,
      );
    }
  }

  // Remove what the input dropped. Marks are checked first, so deleting never destroys marks.
  const keptAssessments = new Set(input.assessments.flatMap((a) => (a.id ? [a.id] : [])));
  const removed = existing.assessments
    .filter(
      (assessment) => assessment.section_id === null || assessment.section_id === config.section_id,
    )
    .filter((assessment) => !keptAssessments.has(assessment.id));
  const keptCategories = new Set(input.categories.map((category) => category.ref));
  const removedCategories = existing.categories.filter(
    (category) => !keptCategories.has(category.id),
  );
  // Section-specific additions on a grade default are managed per section, not by this save; they
  // can only go if their category goes.
  const cascaded = existing.assessments.filter(
    (assessment) =>
      assessment.section_id !== null &&
      config.section_id === null &&
      removedCategories.some((category) => category.id === assessment.category_id),
  );
  const toDelete = [
    ...removed.filter((a) => !(a.section_id !== null && config.section_id === null)),
    ...cascaded,
  ];
  const counts = await markCounts(
    tx,
    schoolId,
    toDelete.map((assessment) => assessment.id),
  );
  const withMarks = toDelete.filter((assessment) => (counts.get(assessment.id) ?? 0) > 0);
  if (withMarks.length > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SUBJECT_CONFIG_IN_USE,
      `These assessments already have marks and cannot be removed: ${withMarks
        .map((assessment) => assessment.name)
        .join(", ")}`,
    );
  }
  if (toDelete.length > 0) {
    await tx`
      DELETE FROM app.subject_config_assessments
      WHERE school_id = ${schoolId}::uuid AND id = ANY (${toDelete.map((a) => a.id)}::uuid[])
    `;
  }
  if (removedCategories.length > 0) {
    await tx`
      DELETE FROM app.subject_config_categories
      WHERE school_id = ${schoolId}::uuid AND id = ANY (${removedCategories.map((c) => c.id)}::uuid[])
    `;
  }

  // Categories: update kept ones in place, insert new ones, and map every ref to a real id.
  const categoryIds = new Map<string, string>();
  for (const category of input.categories) {
    if (existingCategoryIds.has(category.ref)) {
      await tx`
        UPDATE app.subject_config_categories SET
          name = ${category.name}, kind = ${category.kind}, scope = ${category.scope},
          weight = ${category.weight}, aggregation = ${category.aggregation},
          drop_lowest = ${category.drop_lowest}, sort_order = ${category.sort_order}
        WHERE id = ${category.ref}::uuid AND school_id = ${schoolId}::uuid
      `;
      categoryIds.set(category.ref, category.ref);
    } else {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.subject_config_categories
          (school_id, subject_config_id, name, kind, scope, weight, aggregation, drop_lowest, sort_order)
        VALUES (${schoolId}::uuid, ${config.id}::uuid, ${category.name}, ${category.kind},
                ${category.scope}, ${category.weight}, ${category.aggregation},
                ${category.drop_lowest}, ${category.sort_order})
        RETURNING id
      `;
      categoryIds.set(category.ref, row!.id);
    }
  }

  for (const assessment of input.assessments) {
    const categoryId = categoryIds.get(assessment.category_ref);
    if (!categoryId) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Assessment "${assessment.name}" refers to an unknown category`,
      );
    }
    if (assessment.id) {
      await tx`
        UPDATE app.subject_config_assessments SET
          category_id = ${categoryId}::uuid, term_id = ${assessment.term_id}::uuid,
          name = ${assessment.name}, max_marks = ${assessment.max_marks},
          weight = ${assessment.weight}, is_mandatory = ${assessment.is_mandatory},
          assessment_date = ${assessment.assessment_date}::date, due_date = ${assessment.due_date}::date,
          sort_order = ${assessment.sort_order}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${assessment.id}::uuid AND school_id = ${schoolId}::uuid
      `;
    } else {
      await tx`
        INSERT INTO app.subject_config_assessments (
          school_id, subject_config_id, academic_year_id, category_id, term_id, name, max_marks,
          weight, is_mandatory, assessment_date, due_date, status, created_by_user_id, sort_order
        ) VALUES (
          ${schoolId}::uuid, ${config.id}::uuid, ${config.academic_year_id}::uuid,
          ${categoryId}::uuid, ${assessment.term_id}::uuid, ${assessment.name},
          ${assessment.max_marks}, ${assessment.weight}, ${assessment.is_mandatory},
          ${assessment.assessment_date}::date, ${assessment.due_date}::date, 'active',
          ${userId}::uuid, ${assessment.sort_order}
        )
      `;
    }
  }

  await tx`
    DELETE FROM app.subject_config_term_weights
    WHERE school_id = ${schoolId}::uuid AND subject_config_id = ${config.id}::uuid
  `;
  for (const weight of input.term_weights) {
    await tx`
      INSERT INTO app.subject_config_term_weights
        (school_id, subject_config_id, academic_year_id, term_id, weight)
      VALUES (${schoolId}::uuid, ${config.id}::uuid, ${config.academic_year_id}::uuid,
              ${weight.term_id}::uuid, ${weight.weight})
    `;
  }
}

async function validateInputForYear(
  tx: TransactionSql,
  schoolId: string,
  year: YearRow,
  program: ProgramRow,
  input: SubjectConfigInput,
): Promise<{ issues: ValidationIssue[]; engine: SubjectGradingConfig; terms: TermRow[] }> {
  const terms = await loadYearTerms(tx, schoolId, year.id);
  if (input.grade_scale_id) {
    const [scale] = await tx<{ id: string }[]>`
      SELECT id FROM app.grade_scales
      WHERE id = ${input.grade_scale_id}::uuid AND school_id = ${schoolId}::uuid
        AND academic_year_id = ${year.id}::uuid
    `;
    if (!scale) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        "The grading scale must belong to the same academic year",
      );
    }
  }
  const scale = await loadScale(tx, schoolId, input.grade_scale_id ?? program.grade_scale_id);
  const engine = inputToEngine(input, terms, scale.bands);
  const issues = [...checkInputReferences(input, terms), ...validateSubjectConfig(engine)];
  // A live (active) year never runs on a broken configuration; a draft may be saved half-done.
  if (year.grading_config_status === "active" && hasErrors(issues)) invalid(issues);
  if (
    issues.some((issue) =>
      [
        "TERM_UNKNOWN",
        "DUPLICATE_CATEGORY_REF",
        "DUPLICATE_ASSESSMENT_ID",
        "ASSESSMENT_CATEGORY_UNKNOWN",
      ].includes(issue.code),
    )
  ) {
    invalid(issues);
  }
  return { issues, engine, terms };
}

const CONFIG_INSERT_COLUMNS = `
  school_id, academic_year_id, grade_level_id, section_id, subject_id, requirement,
  include_in_average, include_on_certificate, average_weight, grading_method, max_marks,
  pass_percentage, final_exam_pass_percentage, grade_scale_id, rounding_decimals, rounding_mode,
  missing_mark_policy, absent_policy, retake_policy, retake_cap_percentage,
  teachers_can_add_assessments, teacher_assessments_require_approval, instructions,
  is_excluded, based_on_revision`;

/**
 * Create a subject's grade default (`sectionId` null) or a section-only subject (a subject the
 * grade does not have, taught in one section).
 */
export async function createSubjectConfig(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  target: { yearId: string; gradeLevelId: string; sectionId: string | null; subjectId: string },
  input: SubjectConfigInput,
): Promise<SaveResult> {
  const year = await requireYear(tx, schoolId, target.yearId);
  assertConfigEditable(year);
  const program = await requireProgram(tx, schoolId, target.yearId, target.gradeLevelId);
  const [subject] = await tx<{ id: string }[]>`
    SELECT id FROM app.subjects WHERE id = ${target.subjectId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!subject)
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Subject not found");

  let section: SectionRow | null = null;
  if (target.sectionId) {
    section = await requireSectionRow(tx, schoolId, target.sectionId);
    if (
      section.academic_year_id !== target.yearId ||
      section.grade_level_id !== target.gradeLevelId
    ) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        "Section is not in this grade and year",
      );
    }
    const effective = await resolveSectionSubjects(tx, schoolId, section);
    if (effective.some((candidate) => candidate.subject_id === target.subjectId)) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SUBJECT_CONFIG_DUPLICATE,
        "This section already has this subject; customize it instead of adding it again",
      );
    }
  }

  await validateInputForYear(tx, schoolId, year, program, input);

  let inserted: { id: string } | undefined;
  try {
    [inserted] = await tx.savepoint(
      (sp) => sp<{ id: string }[]>`
        INSERT INTO app.subject_configs (${sp.unsafe(CONFIG_INSERT_COLUMNS)})
        VALUES (
          ${schoolId}::uuid, ${target.yearId}::uuid, ${target.gradeLevelId}::uuid,
          ${target.sectionId}::uuid, ${target.subjectId}::uuid, ${input.requirement},
          ${input.include_in_average}, ${input.include_on_certificate}, ${input.average_weight},
          ${input.grading_method}, ${input.max_marks}, ${input.pass_percentage},
          ${input.final_exam_pass_percentage}, ${input.grade_scale_id}::uuid,
          ${input.rounding_decimals}, ${input.rounding_mode}, ${input.missing_mark_policy},
          ${input.absent_policy}, ${input.retake_policy}, ${input.retake_cap_percentage},
          ${input.teachers_can_add_assessments}, ${input.teacher_assessments_require_approval},
          ${input.instructions}, false, NULL
        )
        RETURNING id
      `,
    );
  } catch (error) {
    if (isPgError(error, "23505")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SUBJECT_CONFIG_DUPLICATE,
        "This subject is already assigned to this grade for the academic year",
      );
    }
    throw error;
  }
  const config = await requireConfig(tx, schoolId, inserted!.id);
  await writeStructure(tx, schoolId, userId, config, input, { categories: [], assessments: [] });

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "subject_configs",
    targetId: config.id,
    newValues: { ...target, ...input },
  });

  const affected = section
    ? [section.id]
    : (await sectionsOfGrade(tx, schoolId, target.yearId, target.gradeLevelId)).map((s) => s.id);
  return { config: await getConfigView(tx, schoolId, config.id), affected_section_ids: affected };
}

async function sectionsOfGrade(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  gradeLevelId: string,
): Promise<{ id: string; name: string }[]> {
  return tx<{ id: string; name: string }[]>`
    SELECT id, name FROM app.sections
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
      AND grade_level_id = ${gradeLevelId}::uuid
    ORDER BY name
  `;
}

export interface ConfigImpact {
  config_id: string;
  is_grade_default: boolean;
  revision: number;
  mark_count: number;
  /** Sections whose results change when this config changes. */
  inheriting_sections: { section_id: string; name: string; mark_count: number }[];
  /** Sections with their own configuration: untouched by this config's changes. */
  overriding_sections: {
    section_id: string;
    name: string;
    config_id: string;
    excluded: boolean;
    based_on_revision: number | null;
    outdated: boolean;
  }[];
  /** Sections with finalized results for this subject: those results are snapshots and stay put. */
  finalized_sections: { section_id: string; name: string; term_id: string | null }[];
}

export async function getConfigImpact(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
): Promise<ConfigImpact> {
  const config = await requireConfig(tx, schoolId, configId);
  const sections =
    config.section_id === null
      ? await sectionsOfGrade(tx, schoolId, config.academic_year_id, config.grade_level_id)
      : await tx<{ id: string; name: string }[]>`
          SELECT id, name FROM app.sections WHERE id = ${config.section_id}::uuid AND school_id = ${schoolId}::uuid
        `;
  const overrides =
    config.section_id === null
      ? await tx<
          {
            id: string;
            section_id: string;
            is_excluded: boolean;
            based_on_revision: number | null;
          }[]
        >`
          SELECT id, section_id, is_excluded, based_on_revision FROM app.subject_configs
          WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${config.academic_year_id}::uuid
            AND grade_level_id = ${config.grade_level_id}::uuid AND subject_id = ${config.subject_id}::uuid
            AND section_id IS NOT NULL
        `
      : [];
  const overrideBySection = new Map(overrides.map((row) => [row.section_id, row]));

  const markRows = await tx<{ section_id: string; count: number }[]>`
    SELECT placement.section_id, count(*)::int AS count
    FROM app.student_marks AS mark
    JOIN app.subject_config_assessments AS assessment
      ON assessment.id = mark.assessment_id AND assessment.school_id = mark.school_id
    JOIN app.student_sections AS placement
      ON placement.student_id = mark.student_id AND placement.school_id = mark.school_id
     AND placement.academic_year_id = mark.academic_year_id
    WHERE mark.school_id = ${schoolId}::uuid AND assessment.subject_config_id = ${configId}::uuid
    GROUP BY placement.section_id
  `;
  const marksBySection = new Map(markRows.map((row) => [row.section_id, row.count]));

  const finalized = await tx<{ section_id: string; name: string; term_id: string | null }[]>`
    SELECT DISTINCT finalization.section_id, section.name, finalization.term_id
    FROM app.result_finalizations AS finalization
    JOIN app.sections AS section
      ON section.id = finalization.section_id AND section.school_id = finalization.school_id
    JOIN app.student_subject_results AS result
      ON result.finalization_id = finalization.id AND result.school_id = finalization.school_id
    WHERE finalization.school_id = ${schoolId}::uuid AND finalization.status = 'finalized'
      AND result.subject_id = ${config.subject_id}::uuid
      AND finalization.section_id = ANY (${sections.map((s) => s.id)}::uuid[])
  `;

  return {
    config_id: configId,
    is_grade_default: config.section_id === null,
    revision: config.revision,
    mark_count: markRows.reduce((total, row) => total + row.count, 0),
    inheriting_sections: sections
      .filter((section) => !overrideBySection.has(section.id))
      .map((section) => ({
        section_id: section.id,
        name: section.name,
        mark_count: marksBySection.get(section.id) ?? 0,
      })),
    overriding_sections: sections
      .filter((section) => overrideBySection.has(section.id))
      .map((section) => {
        const override = overrideBySection.get(section.id)!;
        return {
          section_id: section.id,
          name: section.name,
          config_id: override.id,
          excluded: override.is_excluded,
          based_on_revision: override.based_on_revision,
          outdated:
            override.based_on_revision !== null && override.based_on_revision < config.revision,
        };
      }),
    finalized_sections: finalized.map((row) => ({
      section_id: row.section_id,
      name: row.name,
      term_id: row.term_id,
    })),
  };
}

/**
 * Replace a config's rules and structure.
 *
 * Existing assessments keep their ids (and marks) when the input names them. If marks already exist
 * and the grading-relevant part of the configuration changes, the save is refused with
 * ACADEMIC_CONFIG_IMPACT_UNCONFIRMED until the admin has reviewed the impact and resends with
 * `confirm_impact`. Finalized results are snapshots and are never touched.
 */
export async function updateSubjectConfig(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  configId: string,
  input: SubjectConfigInput,
  options: { confirmImpact: boolean; expectedUpdatedAt?: string },
): Promise<SaveResult> {
  const before = await loadConfigDetail(tx, schoolId, configId);
  const { config } = before;
  if (config.is_excluded) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "This section does not offer the subject; reset it to the grade default first",
    );
  }
  if (
    options.expectedUpdatedAt &&
    new Date(options.expectedUpdatedAt).getTime() !== config.updated_at.getTime()
  ) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.GRADE_CONCURRENT_EDIT,
      "This configuration was changed by someone else. Reload and try again.",
    );
  }
  const year = await requireYear(tx, schoolId, config.academic_year_id);
  assertConfigEditable(year);
  const program = await requireProgram(
    tx,
    schoolId,
    config.academic_year_id,
    config.grade_level_id,
  );
  const { engine: proposed } = await validateInputForYear(tx, schoolId, year, program, input);

  // Shrinking an assessment's maximum below a recorded score would make that mark impossible.
  const highest = await maxScores(
    tx,
    schoolId,
    input.assessments.flatMap((a) => (a.id ? [a.id] : [])),
  );
  for (const assessment of input.assessments) {
    if (assessment.id && (highest.get(assessment.id) ?? 0) > assessment.max_marks) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.MARK_SCORE_OUT_OF_RANGE,
        `"${assessment.name}" already has a mark of ${highest.get(assessment.id)}, above the new maximum of ${assessment.max_marks}`,
      );
    }
  }

  // The grade default's section-only additions are not part of this save's input; keep them in
  // the comparison so they do not read as removed.
  const current = toEngineConfig({
    ...before,
    assessments: before.assessments.filter(
      (assessment) => config.section_id !== null || assessment.section_id === null,
    ),
  });
  const changed =
    gradingSignature(current, signatureFlags(config)) !==
    gradingSignature(proposed, signatureFlags(input));
  const impact = await getConfigImpact(tx, schoolId, configId);
  if (changed && impact.mark_count > 0 && !options.confirmImpact) {
    const sections = impact.inheriting_sections.filter((s) => s.mark_count > 0).map((s) => s.name);
    throw new CodedHttpException(
      409,
      ERROR_CODES.ACADEMIC_CONFIG_IMPACT_UNCONFIRMED,
      `${impact.mark_count} recorded marks${sections.length ? ` in ${sections.join(", ")}` : ""} will be recalculated under the new rules. Review the impact and confirm to continue.`,
    );
  }

  await tx`
    UPDATE app.subject_configs SET
      requirement = ${input.requirement},
      include_in_average = ${input.include_in_average},
      include_on_certificate = ${input.include_on_certificate},
      average_weight = ${input.average_weight},
      grading_method = ${input.grading_method},
      max_marks = ${input.max_marks},
      pass_percentage = ${input.pass_percentage},
      final_exam_pass_percentage = ${input.final_exam_pass_percentage},
      grade_scale_id = ${input.grade_scale_id}::uuid,
      rounding_decimals = ${input.rounding_decimals},
      rounding_mode = ${input.rounding_mode},
      missing_mark_policy = ${input.missing_mark_policy},
      absent_policy = ${input.absent_policy},
      retake_policy = ${input.retake_policy},
      retake_cap_percentage = ${input.retake_cap_percentage},
      teachers_can_add_assessments = ${input.teachers_can_add_assessments},
      teacher_assessments_require_approval = ${input.teacher_assessments_require_approval},
      instructions = ${input.instructions},
      revision = revision + ${changed ? 1 : 0},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${configId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await writeStructure(tx, schoolId, userId, config, input, before);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "subject_configs",
    targetId: configId,
    oldValues: { revision: config.revision, engine: current },
    newValues: {
      revision: config.revision + (changed ? 1 : 0),
      engine: proposed,
      confirm_impact: options.confirmImpact,
      affected_mark_count: changed ? impact.mark_count : 0,
    },
  });

  return {
    config: await getConfigView(tx, schoolId, configId),
    affected_section_ids: changed ? impact.inheriting_sections.map((s) => s.section_id) : [],
  };
}

export async function deleteSubjectConfig(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
): Promise<void> {
  const config = await requireConfig(tx, schoolId, configId);
  assertConfigEditable(await requireYear(tx, schoolId, config.academic_year_id));
  if (config.section_id === null) {
    const [override] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.subject_configs
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${config.academic_year_id}::uuid
        AND grade_level_id = ${config.grade_level_id}::uuid AND subject_id = ${config.subject_id}::uuid
        AND section_id IS NOT NULL
    `;
    if ((override?.count ?? 0) > 0) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SUBJECT_CONFIG_IN_USE,
        "Some sections customize this subject; reset or remove their configurations first",
      );
    }
  }
  try {
    await tx.savepoint(
      (sp) =>
        sp`DELETE FROM app.subject_configs WHERE id = ${configId}::uuid AND school_id = ${schoolId}::uuid`,
    );
  } catch (error) {
    if (isPgError(error, "23503")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SUBJECT_CONFIG_IN_USE,
        "This subject configuration has marks or finalized results and cannot be removed",
      );
    }
    throw error;
  }
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "subject_configs",
    targetId: configId,
    oldValues: {
      subject_id: config.subject_id,
      section_id: config.section_id,
      revision: config.revision,
    },
  });
}

// ---------------------------------------------------------------------------
// Section overrides
// ---------------------------------------------------------------------------

export interface SectionSubjectView {
  subject_id: string;
  subject_code: string;
  subject_name: string;
  source: "inherited" | "override" | "section_only" | "excluded";
  config_id: string | null;
  grade_config_id: string | null;
  override_config_id: string | null;
  requirement: SubjectRequirement;
  outdated: boolean;
  grade_revision: number | null;
  based_on_revision: number | null;
  teachers: { teacher_id: string; name: string; assignment_id: string | null }[];
}

export async function listSectionSubjects(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<{ section: SectionRow; subjects: SectionSubjectView[] }> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  const subjects = await resolveSectionSubjects(tx, schoolId, section);
  const revisions = await tx<{ id: string; revision: number; based_on_revision: number | null }[]>`
    SELECT id, revision, based_on_revision FROM app.subject_configs
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${section.academic_year_id}::uuid
      AND grade_level_id = ${section.grade_level_id}::uuid
      AND (section_id IS NULL OR section_id = ${sectionId}::uuid)
  `;
  const byId = new Map(revisions.map((row) => [row.id, row]));
  const teachers = await sectionTeachers(tx, schoolId, sectionId);
  return {
    section,
    subjects: subjects.map((subject) => ({
      ...subject,
      grade_revision: subject.grade_config_id
        ? (byId.get(subject.grade_config_id)?.revision ?? null)
        : null,
      based_on_revision: subject.override_config_id
        ? (byId.get(subject.override_config_id)?.based_on_revision ?? null)
        : null,
      teachers: teachers.filter((teacher) => teacher.subject_id === subject.subject_id),
    })),
  };
}

/** Explicit assignments plus teachers who already teach a class of the section in the subject. */
async function sectionTeachers(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<
  { subject_id: string; teacher_id: string; name: string; assignment_id: string | null }[]
> {
  return tx<
    { subject_id: string; teacher_id: string; name: string; assignment_id: string | null }[]
  >`
    SELECT assignment.subject_id, assignment.teacher_id, users.display_name AS name,
           assignment.id AS assignment_id
    FROM app.section_subject_teachers AS assignment
    JOIN app.teachers AS teacher ON teacher.id = assignment.teacher_id AND teacher.school_id = assignment.school_id
    JOIN app.users AS users ON users.id = teacher.user_id AND users.school_id = teacher.school_id
    WHERE assignment.school_id = ${schoolId}::uuid AND assignment.section_id = ${sectionId}::uuid
    UNION
    SELECT course.subject_id, class.lead_teacher_id, users.display_name, NULL
    FROM app.classes AS class
    JOIN app.courses AS course ON course.id = class.course_id AND course.school_id = class.school_id
    JOIN app.teachers AS teacher ON teacher.id = class.lead_teacher_id AND teacher.school_id = class.school_id
    JOIN app.users AS users ON users.id = teacher.user_id AND users.school_id = teacher.school_id
    WHERE class.school_id = ${schoolId}::uuid AND class.section_id = ${sectionId}::uuid
      AND class.status IN ('planned', 'active')
      AND NOT EXISTS (
        SELECT 1 FROM app.section_subject_teachers AS explicit
        WHERE explicit.school_id = class.school_id AND explicit.section_id = class.section_id
          AND explicit.subject_id = course.subject_id AND explicit.teacher_id = class.lead_teacher_id
      )
  `;
}

/**
 * Give a section its own configuration for an inherited subject.
 *
 *  - `customize`: copy the grade default (rules, categories, term weights and every assessment that
 *    applies to the section) into a section override. Marks the section's students already have
 *    move to the copied assessments, so nothing has to be re-entered.
 *  - `exclude`: the section does not offer the subject. Refused once marks exist.
 */
export async function createSectionOverride(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  subjectId: string,
  mode: "customize" | "exclude",
): Promise<SaveResult> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  assertConfigEditable(await requireYear(tx, schoolId, section.academic_year_id));
  const subjects = await resolveSectionSubjects(tx, schoolId, section);
  const subject = subjects.find((candidate) => candidate.subject_id === subjectId);
  if (!subject || subject.source !== "inherited") {
    throw new CodedHttpException(
      409,
      subject ? ERROR_CODES.SUBJECT_CONFIG_DUPLICATE : ERROR_CODES.SUBJECT_CONFIG_NOT_FOUND,
      subject
        ? "This section already has its own configuration for the subject"
        : "The grade has no default for this subject",
    );
  }
  const grade = await loadConfigDetail(tx, schoolId, subject.grade_config_id!);
  const applicable = grade.assessments.filter(
    (assessment) => assessment.section_id === null || assessment.section_id === sectionId,
  );
  const placed = await tx<{ student_id: string }[]>`
    SELECT student_id FROM app.student_sections
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
  `;
  const studentIds = placed.map((row) => row.student_id);
  const sectionMarks =
    studentIds.length === 0 || applicable.length === 0
      ? []
      : await tx<{ id: string; assessment_id: string }[]>`
          SELECT id, assessment_id FROM app.student_marks
          WHERE school_id = ${schoolId}::uuid
            AND assessment_id = ANY (${applicable.map((a) => a.id)}::uuid[])
            AND student_id = ANY (${studentIds}::uuid[])
        `;

  if (mode === "exclude" && sectionMarks.length > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SECTION_OVERRIDE_HAS_MARKS,
      "Students in this section already have marks in this subject",
    );
  }

  const g = grade.config;
  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.subject_configs (${tx.unsafe(CONFIG_INSERT_COLUMNS)})
    VALUES (
      ${schoolId}::uuid, ${g.academic_year_id}::uuid, ${g.grade_level_id}::uuid, ${sectionId}::uuid,
      ${g.subject_id}::uuid, ${g.requirement}, ${g.include_in_average}, ${g.include_on_certificate},
      ${g.average_weight}, ${g.grading_method}, ${g.max_marks}, ${g.pass_percentage},
      ${g.final_exam_pass_percentage}, ${g.grade_scale_id}::uuid, ${g.rounding_decimals},
      ${g.rounding_mode}, ${g.missing_mark_policy}, ${g.absent_policy}, ${g.retake_policy},
      ${g.retake_cap_percentage}, ${g.teachers_can_add_assessments},
      ${g.teacher_assessments_require_approval}, ${g.instructions}, ${mode === "exclude"},
      ${g.revision}
    )
    RETURNING id
  `;
  const overrideId = inserted!.id;

  if (mode === "customize") {
    const categoryMap = new Map<string, string>();
    for (const category of grade.categories) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.subject_config_categories
          (school_id, subject_config_id, name, kind, scope, weight, aggregation, drop_lowest, sort_order)
        VALUES (${schoolId}::uuid, ${overrideId}::uuid, ${category.name}, ${category.kind},
                ${category.scope}, ${category.weight}, ${category.aggregation},
                ${category.drop_lowest}, ${category.sort_order})
        RETURNING id
      `;
      categoryMap.set(category.id, row!.id);
    }
    for (const weight of grade.termWeights) {
      await tx`
        INSERT INTO app.subject_config_term_weights
          (school_id, subject_config_id, academic_year_id, term_id, weight)
        VALUES (${schoolId}::uuid, ${overrideId}::uuid, ${g.academic_year_id}::uuid,
                ${weight.term_id}::uuid, ${weight.weight})
      `;
    }
    const assessmentMap = new Map<string, string>();
    for (const assessment of applicable) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.subject_config_assessments (
          school_id, subject_config_id, academic_year_id, category_id, term_id, name, max_marks,
          weight, is_mandatory, assessment_date, due_date, status, created_by_user_id, sort_order
        ) VALUES (
          ${schoolId}::uuid, ${overrideId}::uuid, ${g.academic_year_id}::uuid,
          ${categoryMap.get(assessment.category_id)!}::uuid, ${assessment.term_id}::uuid,
          ${assessment.name}, ${assessment.max_marks}, ${assessment.weight},
          ${assessment.is_mandatory}, ${assessment.assessment_date}::date,
          ${assessment.due_date}::date, ${assessment.status}, ${assessment.created_by_user_id}::uuid,
          ${assessment.sort_order}
        )
        RETURNING id
      `;
      assessmentMap.set(assessment.id, row!.id);
    }
    // Move this section's marks onto the copies (a finalized term refuses, by trigger).
    try {
      for (const [from, to] of assessmentMap) {
        if (studentIds.length === 0) break;
        await tx.savepoint(
          (sp) => sp`
            UPDATE app.student_marks SET assessment_id = ${to}::uuid, updated_at = CURRENT_TIMESTAMP
            WHERE school_id = ${schoolId}::uuid AND assessment_id = ${from}::uuid
              AND student_id = ANY (${studentIds}::uuid[])
          `,
        );
      }
    } catch (error) {
      if (isPgError(error, "23514")) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.MARKS_LOCKED,
          "Some of this section's marks are part of finalized results; the subject cannot be customized now",
        );
      }
      throw error;
    }
    // Section-only additions on the grade default now live in the override.
    const moved = applicable.filter((assessment) => assessment.section_id === sectionId);
    if (moved.length > 0) {
      await tx`
        DELETE FROM app.subject_config_assessments AS assessment
        WHERE assessment.school_id = ${schoolId}::uuid
          AND assessment.id = ANY (${moved.map((a) => a.id)}::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM app.student_marks AS mark
            WHERE mark.assessment_id = assessment.id AND mark.school_id = assessment.school_id
          )
      `;
    }
  }

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "subject_configs",
    targetId: overrideId,
    newValues: {
      section_id: sectionId,
      subject_id: subjectId,
      mode,
      based_on_config_id: g.id,
      based_on_revision: g.revision,
      moved_mark_count: mode === "customize" ? sectionMarks.length : 0,
    },
  });
  return {
    config: await getConfigView(tx, schoolId, overrideId),
    affected_section_ids: [sectionId],
  };
}

/**
 * Accept the grade default again: drop the section's override so it inherits. Refused while the
 * override's own assessments carry marks (they have nowhere to go).
 */
export async function resetSectionOverride(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
): Promise<void> {
  const config = await requireConfig(tx, schoolId, configId);
  if (config.section_id === null) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "This is a grade default, not a section override",
    );
  }
  assertConfigEditable(await requireYear(tx, schoolId, config.academic_year_id));
  const [marks] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM app.student_marks AS mark
    JOIN app.subject_config_assessments AS assessment
      ON assessment.id = mark.assessment_id AND assessment.school_id = mark.school_id
    WHERE mark.school_id = ${schoolId}::uuid AND assessment.subject_config_id = ${configId}::uuid
  `;
  if ((marks?.count ?? 0) > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SECTION_OVERRIDE_HAS_MARKS,
      "This section's configuration already has marks, so it cannot be reset to the grade defaults",
    );
  }
  await deleteSubjectConfig(tx, schoolId, configId);
}

/** Keep the override as it is and mark the grade default's latest revision as reviewed. */
export async function acknowledgeGradeRevision(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
): Promise<ConfigView> {
  const config = await requireConfig(tx, schoolId, configId);
  if (config.section_id === null || config.based_on_revision === null) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Only a section override follows a grade default",
    );
  }
  const [grade] = await tx<{ revision: number }[]>`
    SELECT revision FROM app.subject_configs
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${config.academic_year_id}::uuid
      AND grade_level_id = ${config.grade_level_id}::uuid AND subject_id = ${config.subject_id}::uuid
      AND section_id IS NULL
  `;
  if (!grade)
    throw new CodedHttpException(
      404,
      ERROR_CODES.SUBJECT_CONFIG_NOT_FOUND,
      "The grade default no longer exists",
    );
  await tx`
    UPDATE app.subject_configs SET based_on_revision = ${grade.revision}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${configId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "subject_configs",
    targetId: configId,
    oldValues: { based_on_revision: config.based_on_revision },
    newValues: { based_on_revision: grade.revision, decision: "keep_override" },
  });
  return getConfigView(tx, schoolId, configId);
}

// ---------------------------------------------------------------------------
// Teacher assignments
// ---------------------------------------------------------------------------

export interface TeacherAssignmentView {
  id: string;
  academic_year_id: string;
  section_id: string;
  section_name: string;
  grade_level_name: string;
  subject_id: string;
  subject_name: string;
  teacher_id: string;
  teacher_name: string;
}

export async function listTeacherAssignments(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  filter: { teacherId?: string } = {},
): Promise<TeacherAssignmentView[]> {
  const teacherFilter = filter.teacherId
    ? tx`AND assignment.teacher_id = ${filter.teacherId}::uuid`
    : tx``;
  return tx<TeacherAssignmentView[]>`
    SELECT assignment.id, assignment.academic_year_id, assignment.section_id,
           section.name AS section_name, grade.name AS grade_level_name, assignment.subject_id,
           subject.name AS subject_name, assignment.teacher_id, users.display_name AS teacher_name
    FROM app.section_subject_teachers AS assignment
    JOIN app.sections AS section ON section.id = assignment.section_id AND section.school_id = assignment.school_id
    JOIN app.grade_levels AS grade ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    JOIN app.subjects AS subject ON subject.id = assignment.subject_id AND subject.school_id = assignment.school_id
    JOIN app.teachers AS teacher ON teacher.id = assignment.teacher_id AND teacher.school_id = assignment.school_id
    JOIN app.users AS users ON users.id = teacher.user_id AND users.school_id = teacher.school_id
    WHERE assignment.school_id = ${schoolId}::uuid AND assignment.academic_year_id = ${yearId}::uuid
      ${teacherFilter}
    ORDER BY grade.sort_order, section.name, subject.name, users.display_name
  `;
}

export async function createTeacherAssignment(
  tx: TransactionSql,
  schoolId: string,
  input: { section_id: string; subject_id: string; teacher_id: string },
): Promise<TeacherAssignmentView> {
  const section = await requireSectionRow(tx, schoolId, input.section_id);
  const subjects = await resolveSectionSubjects(tx, schoolId, section);
  if (!subjects.some((s) => s.subject_id === input.subject_id && s.config_id !== null)) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SUBJECT_CONFIG_NOT_FOUND,
      "This subject is not taught in this section",
    );
  }
  const [teacher] = await tx<{ id: string }[]>`
    SELECT id FROM app.teachers WHERE id = ${input.teacher_id}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!teacher)
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Teacher not found");
  let row: { id: string } | undefined;
  try {
    [row] = await tx.savepoint(
      (sp) => sp<{ id: string }[]>`
        INSERT INTO app.section_subject_teachers (school_id, academic_year_id, section_id, subject_id, teacher_id)
        VALUES (${schoolId}::uuid, ${section.academic_year_id}::uuid, ${input.section_id}::uuid,
                ${input.subject_id}::uuid, ${input.teacher_id}::uuid)
        RETURNING id
      `,
    );
  } catch (error) {
    if (isPgError(error, "23505")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.TEACHER_ASSIGNMENT_DUPLICATE,
        "This teacher is already assigned to this subject in this section",
      );
    }
    throw error;
  }
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "section_subject_teachers",
    targetId: row!.id,
    newValues: input,
  });
  const views = await listTeacherAssignments(tx, schoolId, section.academic_year_id);
  return views.find((view) => view.id === row!.id)!;
}

export async function deleteTeacherAssignment(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
): Promise<void> {
  const deleted = await tx<{ section_id: string; subject_id: string; teacher_id: string }[]>`
    DELETE FROM app.section_subject_teachers
    WHERE id = ${assignmentId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING section_id, subject_id, teacher_id
  `;
  if (deleted.length === 0) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.RESOURCE_NOT_FOUND,
      "Teacher assignment not found",
    );
  }
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "section_subject_teachers",
    targetId: assignmentId,
    oldValues: { ...deleted[0] },
  });
}

// ---------------------------------------------------------------------------
// Electives and exemptions
// ---------------------------------------------------------------------------

export interface SubjectEnrollmentView {
  student_id: string;
  subject_id: string;
  status: "enrolled" | "exempt";
  reason: string | null;
  updated_at: string;
}

export async function listSubjectEnrollments(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<SubjectEnrollmentView[]> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  const rows = await tx<(Omit<SubjectEnrollmentView, "updated_at"> & { updated_at: Date })[]>`
    SELECT choice.student_id, choice.subject_id, choice.status, choice.reason, choice.updated_at
    FROM app.student_subject_enrollments AS choice
    JOIN app.student_sections AS placement
      ON placement.student_id = choice.student_id AND placement.school_id = choice.school_id
     AND placement.academic_year_id = choice.academic_year_id
    WHERE choice.school_id = ${schoolId}::uuid AND placement.section_id = ${section.id}::uuid
    ORDER BY choice.subject_id, choice.student_id
  `;
  return rows.map((row) => ({ ...row, updated_at: row.updated_at.toISOString() }));
}

export async function setSubjectEnrollment(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  input: {
    student_id: string;
    subject_id: string;
    status: "enrolled" | "exempt" | "none";
    reason: string | null;
  },
): Promise<void> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  const year = await requireYear(tx, schoolId, section.academic_year_id);
  assertConfigEditable(year);
  const [placed] = await tx<{ id: string }[]>`
    SELECT id FROM app.student_sections
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid AND student_id = ${input.student_id}::uuid
  `;
  if (!placed)
    throw new CodedHttpException(
      404,
      ERROR_CODES.RESOURCE_NOT_FOUND,
      "Student is not in this section",
    );
  const subjects = await resolveSectionSubjects(tx, schoolId, section);
  if (!subjects.some((s) => s.subject_id === input.subject_id && s.config_id !== null)) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SUBJECT_CONFIG_NOT_FOUND,
      "This subject is not taught in this section",
    );
  }
  if (input.status === "exempt" && !input.reason) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "An exemption needs a reason");
  }
  const [before] = await tx<{ status: string; reason: string | null }[]>`
    SELECT status, reason FROM app.student_subject_enrollments
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${section.academic_year_id}::uuid
      AND student_id = ${input.student_id}::uuid AND subject_id = ${input.subject_id}::uuid
  `;
  if (input.status === "none") {
    await tx`
      DELETE FROM app.student_subject_enrollments
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${section.academic_year_id}::uuid
        AND student_id = ${input.student_id}::uuid AND subject_id = ${input.subject_id}::uuid
    `;
  } else {
    await tx`
      INSERT INTO app.student_subject_enrollments
        (school_id, academic_year_id, student_id, subject_id, status, reason)
      VALUES (${schoolId}::uuid, ${section.academic_year_id}::uuid, ${input.student_id}::uuid,
              ${input.subject_id}::uuid, ${input.status},
              ${input.status === "exempt" ? input.reason : null})
      ON CONFLICT (school_id, academic_year_id, student_id, subject_id) DO UPDATE
      SET status = EXCLUDED.status, reason = EXCLUDED.reason, updated_at = CURRENT_TIMESTAMP
    `;
  }
  await emitAuditLog(tx, {
    action: before ? (input.status === "none" ? "delete" : "update") : "insert",
    targetTable: "student_subject_enrollments",
    targetId: input.student_id,
    oldValues: before ? { subject_id: input.subject_id, ...before } : undefined,
    newValues:
      before && input.status === "none"
        ? undefined
        : { subject_id: input.subject_id, status: input.status, reason: input.reason },
  });
}

// ---------------------------------------------------------------------------
// Year configuration status
// ---------------------------------------------------------------------------

export interface PublishIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  grade_level_id?: string;
  section_id?: string;
  subject_id?: string;
  config_id?: string;
}

/** Everything that must hold before a year's configuration can be published. */
export async function collectPublishIssues(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<PublishIssue[]> {
  const issues: PublishIssue[] = [];
  const programs = await listPrograms(tx, schoolId, yearId);
  if (programs.length === 0) {
    issues.push({
      severity: "error",
      code: "NO_GRADES",
      message: "No grade is set up for this academic year.",
    });
  }
  const configs = await tx<{ id: string; is_excluded: boolean }[]>`
    SELECT id, is_excluded FROM app.subject_configs
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
  `;
  for (const row of configs) {
    if (row.is_excluded) continue;
    const loaded = await loadConfigDetail(tx, schoolId, row.id);
    for (const issue of validateSubjectConfig(toEngineConfig(loaded))) {
      issues.push({
        severity: issue.severity,
        code: issue.code,
        message: `${loaded.config.subject_name}: ${issue.message}`,
        grade_level_id: loaded.config.grade_level_id,
        section_id: loaded.config.section_id ?? undefined,
        subject_id: loaded.config.subject_id,
        config_id: loaded.config.id,
      });
    }
  }
  for (const program of programs) {
    const sections = await sectionsOfGrade(tx, schoolId, yearId, program.grade_level_id);
    const hasSubjects =
      configs.length > 0 &&
      (
        await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.subject_configs
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
        AND grade_level_id = ${program.grade_level_id}::uuid
    `
      )[0]!.count > 0;
    if (!hasSubjects) {
      issues.push({
        severity: "error",
        code: "GRADE_WITHOUT_SUBJECTS",
        message: `${program.grade_level_name} has no subjects.`,
        grade_level_id: program.grade_level_id,
      });
    }
    if (sections.length === 0) {
      issues.push({
        severity: "warning",
        code: "GRADE_WITHOUT_SECTIONS",
        message: `${program.grade_level_name} has no sections yet.`,
        grade_level_id: program.grade_level_id,
      });
    }
    for (const section of sections) {
      const { subjects } = await listSectionSubjects(tx, schoolId, section.id);
      for (const subject of subjects) {
        if (subject.source !== "excluded" && subject.teachers.length === 0) {
          issues.push({
            severity: "warning",
            code: "MISSING_TEACHER",
            message: `${program.grade_level_name} ${section.name}: no teacher for ${subject.subject_name}.`,
            grade_level_id: program.grade_level_id,
            section_id: section.id,
            subject_id: subject.subject_id,
          });
        }
        if (subject.outdated) {
          issues.push({
            severity: "warning",
            code: "OVERRIDE_OUTDATED",
            message: `${program.grade_level_name} ${section.name}: the grade default for ${subject.subject_name} changed since this section was customized.`,
            grade_level_id: program.grade_level_id,
            section_id: section.id,
            subject_id: subject.subject_id,
            config_id: subject.override_config_id ?? undefined,
          });
        }
      }
    }
  }
  return issues;
}

const TRANSITIONS = new Map<GradingConfigStatus, GradingConfigStatus[]>([
  ["draft", ["active"]],
  ["active", ["draft", "finalized"]],
  ["finalized", ["archived"]],
  ["archived", []],
]);

export async function setYearGradingStatus(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  status: GradingConfigStatus,
): Promise<{ status: GradingConfigStatus; issues: PublishIssue[] }> {
  const [locked] = await tx<YearRow[]>`
    SELECT id, code, name, starts_on, ends_on, grading_config_status FROM app.academic_years
    WHERE id = ${yearId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!locked)
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Academic year not found");
  const from = locked.grading_config_status;
  if (!(TRANSITIONS.get(from) ?? []).includes(status)) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `The grading configuration cannot move from ${from} to ${status}`,
    );
  }

  let issues: PublishIssue[] = [];
  if (status === "active") {
    issues = await collectPublishIssues(tx, schoolId, yearId);
    if (issues.some((issue) => issue.severity === "error")) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.ACADEMIC_CONFIG_INVALID,
        `The configuration cannot be published yet: ${issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message)
          .join(" ")}`,
      );
    }
  }
  if (status === "draft") {
    const [marks] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.student_marks
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
    `;
    if ((marks?.count ?? 0) > 0) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CONFLICT_STATE_MISMATCH,
        "Marks have been entered for this year; it can no longer return to draft",
      );
    }
  }
  if (status === "finalized") {
    const pending = await tx<{ name: string; grade: string }[]>`
      SELECT section.name, grade.name AS grade
      FROM app.sections AS section
      JOIN app.grade_levels AS grade ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
      WHERE section.school_id = ${schoolId}::uuid AND section.academic_year_id = ${yearId}::uuid
        AND EXISTS (
          SELECT 1 FROM app.student_sections AS placement
          WHERE placement.section_id = section.id AND placement.school_id = section.school_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.result_finalizations AS finalization
          WHERE finalization.section_id = section.id AND finalization.school_id = section.school_id
            AND finalization.term_id IS NULL AND finalization.status = 'finalized'
        )
      ORDER BY grade.sort_order, section.name
    `;
    if (pending.length > 0) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.RESULTS_INCOMPLETE,
        `Finalize the annual results of every section first: ${pending
          .map((row) => `${row.grade} ${row.name}`)
          .join(", ")}`,
      );
    }
  }

  await tx`
    UPDATE app.academic_years SET grading_config_status = ${status}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${yearId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "academic_years",
    targetId: yearId,
    oldValues: { grading_config_status: from },
    newValues: { grading_config_status: status },
  });
  return { status, issues };
}
