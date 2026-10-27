import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import type {
  CategoryAggregation,
  CategoryKind,
  CategoryScope,
  GradeBand,
  MarkInput,
  OverallPolicy,
  RoundingMode,
  SubjectGradingConfig,
  SubjectRequirement,
} from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Reads grading configuration rows and turns them into @studafy/grading-engine input.
 *
 * This is the only place the API maps the database onto the engine, so every caller (mark sheet
 * preview, finalization, overview, corrections) computes from the same effective configuration:
 *
 *   effective config for (section, subject) =
 *     the section's override row, if it has one (and it is not `is_excluded`),
 *     otherwise the grade default for the section's grade and year;
 *   its assessments = active assessments with no section, plus active ones added for this section.
 */

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface SubjectConfigRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  grade_level_id: string;
  section_id: string | null;
  subject_id: string;
  subject_code: string;
  subject_name: string;
  requirement: SubjectRequirement;
  include_in_average: boolean;
  include_on_certificate: boolean;
  average_weight: string;
  grading_method: "weighted" | "total_points";
  max_marks: string;
  pass_percentage: string;
  final_exam_pass_percentage: string | null;
  grade_scale_id: string | null;
  rounding_decimals: number;
  rounding_mode: RoundingMode;
  missing_mark_policy: "incomplete" | "zero";
  absent_policy: "incomplete" | "zero";
  retake_policy: "none" | "replace" | "highest" | "capped";
  retake_cap_percentage: string | null;
  teachers_can_add_assessments: boolean;
  teacher_assessments_require_approval: boolean;
  instructions: string | null;
  is_excluded: boolean;
  revision: number;
  based_on_revision: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface CategoryRow {
  id: string;
  subject_config_id: string;
  name: string;
  kind: CategoryKind;
  scope: CategoryScope;
  weight: string | null;
  aggregation: CategoryAggregation;
  drop_lowest: number;
  sort_order: number;
}

export interface AssessmentRow {
  id: string;
  subject_config_id: string;
  category_id: string;
  term_id: string | null;
  section_id: string | null;
  name: string;
  max_marks: string;
  weight: string;
  is_mandatory: boolean;
  assessment_date: string | null;
  due_date: string | null;
  status: "active" | "proposed" | "rejected";
  created_by_user_id: string | null;
  sort_order: number;
  updated_at: Date;
}

export interface TermRow {
  id: string;
  name: string;
  sequence_number: number;
  starts_on: string;
  ends_on: string;
}

export interface TermWeightRow {
  term_id: string;
  weight: string;
}

export interface ProgramRow {
  id: string;
  academic_year_id: string;
  grade_level_id: string;
  grade_level_name: string;
  grade_scale_id: string | null;
  max_failed_subjects_for_supplementary: number;
  mark_approval_required: boolean;
  average_rounding_decimals: number;
  average_rounding_mode: RoundingMode;
  updated_at: Date;
}

export interface LoadedConfig {
  config: SubjectConfigRow;
  categories: CategoryRow[];
  assessments: AssessmentRow[];
  termWeights: TermWeightRow[];
  terms: TermRow[];
  scale: GradeBand[];
  scaleName: string | null;
}

/** What one section does with one subject. */
export type SubjectSource = "inherited" | "override" | "section_only" | "excluded";

export interface EffectiveSubject {
  subject_id: string;
  subject_code: string;
  subject_name: string;
  source: SubjectSource;
  /** The config that applies (the override, or the grade default). Null when excluded. */
  config_id: string | null;
  grade_config_id: string | null;
  override_config_id: string | null;
  requirement: SubjectRequirement;
  /** An override forked from an older revision of the grade default. */
  outdated: boolean;
}

export interface RosterStudent {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  /** `exempt` students are listed but take no assessments in the subject. */
  status: "enrolled" | "exempt";
}

/** What a finalized result stores as `config_snapshot`: everything needed to recompute it. */
export interface ConfigSnapshot {
  version: 1;
  subject: { id: string; code: string; name: string };
  subject_config_id: string;
  source: SubjectSource;
  revision: number;
  requirement: SubjectRequirement;
  include_in_average: boolean;
  include_on_certificate: boolean;
  average_weight: number;
  scale_name: string | null;
  engine: SubjectGradingConfig;
  program: {
    max_failed_subjects_for_supplementary: number;
    rounding: { decimals: number; mode: RoundingMode };
    scale: GradeBand[] | null;
  };
}

// ---------------------------------------------------------------------------
// Column lists
// ---------------------------------------------------------------------------

const CONFIG_COLUMNS = `
  config.id, config.school_id, config.academic_year_id, config.grade_level_id, config.section_id,
  config.subject_id, subject.code AS subject_code, subject.name AS subject_name, config.requirement,
  config.include_in_average, config.include_on_certificate, config.average_weight,
  config.grading_method, config.max_marks, config.pass_percentage,
  config.final_exam_pass_percentage, config.grade_scale_id, config.rounding_decimals,
  config.rounding_mode, config.missing_mark_policy, config.absent_policy, config.retake_policy,
  config.retake_cap_percentage, config.teachers_can_add_assessments,
  config.teacher_assessments_require_approval, config.instructions, config.is_excluded,
  config.revision, config.based_on_revision, config.created_at, config.updated_at`;

export const ASSESSMENT_COLUMNS = `
  assessment.id, assessment.subject_config_id, assessment.category_id, assessment.term_id,
  assessment.section_id, assessment.name, assessment.max_marks, assessment.weight,
  assessment.is_mandatory, assessment.assessment_date::text AS assessment_date,
  assessment.due_date::text AS due_date, assessment.status, assessment.created_by_user_id,
  assessment.sort_order, assessment.updated_at`;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function findConfig(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
): Promise<SubjectConfigRow | undefined> {
  const [row] = await tx<SubjectConfigRow[]>`
    SELECT ${tx.unsafe(CONFIG_COLUMNS)}
    FROM app.subject_configs AS config
    JOIN app.subjects AS subject
      ON subject.id = config.subject_id AND subject.school_id = config.school_id
    WHERE config.id = ${configId}::uuid AND config.school_id = ${schoolId}::uuid
  `;
  return row;
}

export async function requireConfig(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
): Promise<SubjectConfigRow> {
  const row = await findConfig(tx, schoolId, configId);
  if (!row) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SUBJECT_CONFIG_NOT_FOUND,
      "Subject configuration not found",
    );
  }
  return row;
}

export async function listConfigs(
  tx: TransactionSql,
  schoolId: string,
  filter: { yearId: string; gradeLevelId?: string; sectionId?: string | null },
): Promise<SubjectConfigRow[]> {
  const gradeFilter = filter.gradeLevelId
    ? tx`AND config.grade_level_id = ${filter.gradeLevelId}::uuid`
    : tx``;
  const sectionFilter =
    filter.sectionId === undefined
      ? tx``
      : filter.sectionId === null
        ? tx`AND config.section_id IS NULL`
        : tx`AND config.section_id = ${filter.sectionId}::uuid`;
  return tx<SubjectConfigRow[]>`
    SELECT ${tx.unsafe(CONFIG_COLUMNS)}
    FROM app.subject_configs AS config
    JOIN app.subjects AS subject
      ON subject.id = config.subject_id AND subject.school_id = config.school_id
    WHERE config.school_id = ${schoolId}::uuid
      AND config.academic_year_id = ${filter.yearId}::uuid
      ${gradeFilter}
      ${sectionFilter}
    ORDER BY subject.name, config.section_id NULLS FIRST
  `;
}

export async function loadYearTerms(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<TermRow[]> {
  return tx<TermRow[]>`
    SELECT id, name, sequence_number, starts_on::text AS starts_on, ends_on::text AS ends_on
    FROM app.terms
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
    ORDER BY sequence_number
  `;
}

export async function loadScale(
  tx: TransactionSql,
  schoolId: string,
  scaleId: string | null,
): Promise<{ name: string | null; bands: GradeBand[] }> {
  if (!scaleId) return { name: null, bands: [] };
  const rows = await tx<
    { name: string; label: string; min_percentage: string; gpa_points: string | null }[]
  >`
    SELECT scale.name, band.label, band.min_percentage, band.gpa_points
    FROM app.grade_scales AS scale
    LEFT JOIN app.grade_scale_bands AS band
      ON band.grade_scale_id = scale.id AND band.school_id = scale.school_id
    WHERE scale.id = ${scaleId}::uuid AND scale.school_id = ${schoolId}::uuid
    ORDER BY band.min_percentage DESC
  `;
  return {
    name: rows[0]?.name ?? null,
    bands: rows
      .filter((row) => row.label !== null)
      .map((row) => ({
        label: row.label,
        minPercentage: Number(row.min_percentage),
        gpaPoints: row.gpa_points === null ? null : Number(row.gpa_points),
      })),
  };
}

export async function requireProgram(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  gradeLevelId: string,
): Promise<ProgramRow> {
  const [program] = await tx<ProgramRow[]>`
    SELECT program.id, program.academic_year_id, program.grade_level_id,
           grade.name AS grade_level_name, program.grade_scale_id,
           program.max_failed_subjects_for_supplementary, program.mark_approval_required,
           program.average_rounding_decimals, program.average_rounding_mode, program.updated_at
    FROM app.grade_programs AS program
    JOIN app.grade_levels AS grade
      ON grade.id = program.grade_level_id AND grade.school_id = program.school_id
    WHERE program.school_id = ${schoolId}::uuid
      AND program.academic_year_id = ${yearId}::uuid
      AND program.grade_level_id = ${gradeLevelId}::uuid
  `;
  if (!program) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.GRADE_PROGRAM_NOT_FOUND,
      "This grade has not been set up for the academic year",
    );
  }
  return program;
}

/** A config with its categories, assessments, term weights, the year's terms and its scale. */
export async function loadConfigDetail(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
): Promise<LoadedConfig> {
  const config = await requireConfig(tx, schoolId, configId);
  const [categories, assessments, termWeights, terms] = await Promise.all([
    tx<CategoryRow[]>`
      SELECT id, subject_config_id, name, kind, scope, weight, aggregation, drop_lowest, sort_order
      FROM app.subject_config_categories
      WHERE school_id = ${schoolId}::uuid AND subject_config_id = ${configId}::uuid
      ORDER BY sort_order, name
    `,
    tx<AssessmentRow[]>`
      SELECT ${tx.unsafe(ASSESSMENT_COLUMNS)}
      FROM app.subject_config_assessments AS assessment
      WHERE assessment.school_id = ${schoolId}::uuid
        AND assessment.subject_config_id = ${configId}::uuid
      ORDER BY assessment.sort_order, assessment.name
    `,
    tx<TermWeightRow[]>`
      SELECT term_id, weight
      FROM app.subject_config_term_weights
      WHERE school_id = ${schoolId}::uuid AND subject_config_id = ${configId}::uuid
    `,
    loadYearTerms(tx, schoolId, config.academic_year_id),
  ]);
  const program = await requireProgram(
    tx,
    schoolId,
    config.academic_year_id,
    config.grade_level_id,
  );
  const scale = await loadScale(tx, schoolId, config.grade_scale_id ?? program.grade_scale_id);
  return {
    config,
    categories,
    assessments,
    termWeights,
    terms,
    scale: scale.bands,
    scaleName: scale.name,
  };
}

// ---------------------------------------------------------------------------
// Mapping onto the engine
// ---------------------------------------------------------------------------

const num = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * The engine's view of a config. With `sectionId`, only the assessments that apply to that section
 * count (shared ones plus its own additions); without it, every active assessment is included,
 * which is what validating the grade default as a whole needs.
 */
export function toEngineConfig(
  loaded: LoadedConfig,
  options: { sectionId?: string } = {},
): SubjectGradingConfig {
  const { config } = loaded;
  const weights = new Map(loaded.termWeights.map((row) => [row.term_id, Number(row.weight)]));
  return {
    method: config.grading_method,
    maxMarks: Number(config.max_marks),
    passPercentage: Number(config.pass_percentage),
    finalExamPassPercentage: num(config.final_exam_pass_percentage),
    rounding: { decimals: config.rounding_decimals, mode: config.rounding_mode },
    missingPolicy: config.missing_mark_policy,
    absentPolicy: config.absent_policy,
    retakePolicy: config.retake_policy,
    retakeCapPercentage: num(config.retake_cap_percentage),
    scale: loaded.scale,
    terms: loaded.terms.map((term) => ({
      termId: term.id,
      name: term.name,
      sequence: term.sequence_number,
      weight: weights.get(term.id) ?? 0,
    })),
    categories: loaded.categories.map((category) => ({
      id: category.id,
      name: category.name,
      kind: category.kind,
      scope: category.scope,
      weight: num(category.weight),
      aggregation: category.aggregation,
      dropLowest: category.drop_lowest,
    })),
    assessments: loaded.assessments
      .filter((assessment) => assessment.status === "active")
      .filter(
        (assessment) =>
          options.sectionId === undefined ||
          assessment.section_id === null ||
          assessment.section_id === options.sectionId,
      )
      .map((assessment) => ({
        id: assessment.id,
        categoryId: assessment.category_id,
        termId: assessment.term_id,
        name: assessment.name,
        maxMarks: Number(assessment.max_marks),
        weight: Number(assessment.weight),
        mandatory: assessment.is_mandatory,
      })),
  };
}

export function programPolicy(program: ProgramRow, scale: GradeBand[]): OverallPolicy {
  return {
    rounding: {
      decimals: program.average_rounding_decimals,
      mode: program.average_rounding_mode,
    },
    maxFailedSubjectsForSupplementary: program.max_failed_subjects_for_supplementary,
    scale: scale.length > 0 ? scale : null,
  };
}

export function buildSnapshot(
  loaded: LoadedConfig,
  source: SubjectSource,
  engine: SubjectGradingConfig,
  program: ProgramRow,
  programScale: GradeBand[],
): ConfigSnapshot {
  const { config } = loaded;
  return {
    version: 1,
    subject: { id: config.subject_id, code: config.subject_code, name: config.subject_name },
    subject_config_id: config.id,
    source,
    revision: config.revision,
    requirement: config.requirement,
    include_in_average: config.include_in_average,
    include_on_certificate: config.include_on_certificate,
    average_weight: Number(config.average_weight),
    scale_name: loaded.scaleName,
    engine,
    program: {
      max_failed_subjects_for_supplementary: program.max_failed_subjects_for_supplementary,
      rounding: {
        decimals: program.average_rounding_decimals,
        mode: program.average_rounding_mode,
      },
      scale: programScale.length > 0 ? programScale : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Sections: inheritance, rosters and marks
// ---------------------------------------------------------------------------

export interface SectionRow {
  id: string;
  name: string;
  academic_year_id: string;
  grade_level_id: string;
  grade_level_name: string;
  archived_at: Date | null;
}

export async function requireSectionRow(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<SectionRow> {
  const [section] = await tx<SectionRow[]>`
    SELECT section.id, section.name, section.academic_year_id, section.grade_level_id,
           grade.name AS grade_level_name, section.archived_at
    FROM app.sections AS section
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    WHERE section.id = ${sectionId}::uuid AND section.school_id = ${schoolId}::uuid
  `;
  if (!section) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Section not found");
  }
  return section;
}

/**
 * Every subject a section has: the grade defaults it inherits, the ones it overrides or excludes,
 * and any section-only subject. One row per subject — duplicates are impossible by the unique
 * indexes on app.subject_configs.
 */
export async function resolveSectionSubjects(
  tx: TransactionSql,
  schoolId: string,
  section: SectionRow,
): Promise<EffectiveSubject[]> {
  const configs = await tx<SubjectConfigRow[]>`
    SELECT ${tx.unsafe(CONFIG_COLUMNS)}
    FROM app.subject_configs AS config
    JOIN app.subjects AS subject
      ON subject.id = config.subject_id AND subject.school_id = config.school_id
    WHERE config.school_id = ${schoolId}::uuid
      AND config.academic_year_id = ${section.academic_year_id}::uuid
      AND config.grade_level_id = ${section.grade_level_id}::uuid
      AND (config.section_id IS NULL OR config.section_id = ${section.id}::uuid)
    ORDER BY subject.name
  `;
  const defaults = new Map(
    configs.filter((c) => c.section_id === null).map((c) => [c.subject_id, c]),
  );
  const overrides = new Map(
    configs.filter((c) => c.section_id !== null).map((c) => [c.subject_id, c]),
  );
  const subjectIds = [...new Set(configs.map((c) => c.subject_id))];

  return subjectIds.map((subjectId) => {
    const grade = defaults.get(subjectId) ?? null;
    const override = overrides.get(subjectId) ?? null;
    const base = (override ?? grade)!;
    const source: SubjectSource = override
      ? override.is_excluded
        ? "excluded"
        : grade
          ? "override"
          : "section_only"
      : "inherited";
    return {
      subject_id: subjectId,
      subject_code: base.subject_code,
      subject_name: base.subject_name,
      source,
      config_id: source === "excluded" ? null : base.id,
      grade_config_id: grade?.id ?? null,
      override_config_id: override?.id ?? null,
      requirement: (override && !override.is_excluded ? override : (grade ?? override)!)
        .requirement,
      outdated:
        override !== null &&
        grade !== null &&
        override.based_on_revision !== null &&
        override.based_on_revision < grade.revision,
    };
  });
}

export async function requireEffectiveSubject(
  tx: TransactionSql,
  schoolId: string,
  section: SectionRow,
  subjectId: string,
): Promise<EffectiveSubject & { config_id: string }> {
  const subjects = await resolveSectionSubjects(tx, schoolId, section);
  const subject = subjects.find((candidate) => candidate.subject_id === subjectId);
  if (!subject || subject.config_id === null) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SUBJECT_CONFIG_NOT_FOUND,
      "This subject is not taught in this section",
    );
  }
  return subject as EffectiveSubject & { config_id: string };
}

/**
 * Students who take the subject in the section: every placed student for a mandatory subject,
 * only `enrolled` students for an optional or elective one; `exempt` students are listed with
 * that status for any subject.
 */
export async function loadRoster(
  tx: TransactionSql,
  schoolId: string,
  section: SectionRow,
  subjectId: string,
  requirement: SubjectRequirement,
): Promise<RosterStudent[]> {
  const rows = await tx<(Omit<RosterStudent, "status"> & { choice: string | null })[]>`
    SELECT student.id AS student_id, student.first_name, student.last_name,
           student.admission_number, choice.status AS choice
    FROM app.student_sections AS placement
    JOIN app.students AS student
      ON student.id = placement.student_id AND student.school_id = placement.school_id
    LEFT JOIN app.student_subject_enrollments AS choice
      ON choice.student_id = placement.student_id
     AND choice.academic_year_id = placement.academic_year_id
     AND choice.school_id = placement.school_id
     AND choice.subject_id = ${subjectId}::uuid
    WHERE placement.school_id = ${schoolId}::uuid
      AND placement.section_id = ${section.id}::uuid
    ORDER BY student.last_name, student.first_name, student.id
  `;
  return rows
    .filter((row) => requirement === "mandatory" || row.choice !== null)
    .map((row) => ({
      student_id: row.student_id,
      first_name: row.first_name,
      last_name: row.last_name,
      admission_number: row.admission_number,
      status: row.choice === "exempt" ? "exempt" : "enrolled",
    }));
}

export interface MarkRow {
  id: string;
  assessment_id: string;
  student_id: string;
  attempt: 1 | 2;
  status: MarkInput["status"];
  score: string | null;
  remarks: string | null;
  updated_at: Date;
}

export async function loadMarks(
  tx: TransactionSql,
  schoolId: string,
  assessmentIds: string[],
  studentIds: string[],
): Promise<MarkRow[]> {
  if (assessmentIds.length === 0 || studentIds.length === 0) return [];
  return tx<MarkRow[]>`
    SELECT id, assessment_id, student_id, attempt, status, score, remarks, updated_at
    FROM app.student_marks
    WHERE school_id = ${schoolId}::uuid
      AND assessment_id = ANY (${assessmentIds}::uuid[])
      AND student_id = ANY (${studentIds}::uuid[])
  `;
}

export function toMarkInputs(marks: readonly MarkRow[], studentId: string): MarkInput[] {
  return marks
    .filter((mark) => mark.student_id === studentId)
    .map((mark) => ({
      assessmentId: mark.assessment_id,
      attempt: mark.attempt === 2 ? 2 : 1,
      status: mark.status,
      score: mark.score === null ? null : Number(mark.score),
    }));
}
