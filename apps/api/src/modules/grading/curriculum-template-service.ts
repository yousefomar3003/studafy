import { ERROR_CODES } from "@studafy/constants";
import {
  CURRICULUM_TEMPLATES,
  buildTemplateTermStructure,
  getCurriculumTemplate,
  localize,
  templateScaleBands,
} from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { assertConfigEditable, requireYear } from "./access";
import {
  createScale,
  listGradeConfigs,
  updateScale,
  updateSubjectConfig,
  upsertProgram,
} from "./config-service";
import { normalizeDescriptiveInput } from "./descriptor-service";
import { loadDescriptorRows, loadScale, loadYearTerms } from "./engine-config";
import { buildExamTemplate, loadExamSettings } from "./exam-structure";

import type { ConfigView, ProgramInput, SubjectConfigInput } from "./config-service";
import type { DescriptorInput } from "./descriptor-service";
import type { TermRow } from "./engine-config";
import type { SchoolExamSettings } from "./exam-structure";
import type {
  CategoryAggregation,
  CategoryKind,
  CurriculumFamily,
  CurriculumTemplate,
  CurriculumTemplateId,
  GradeBand,
  GradingMethod,
  ResultFormatKind,
  RoundingMode,
  TemplateLocale,
} from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Curriculum templates (packages/grading-engine/src/templates.ts) applied to an academic year.
 *
 * Applying a template to chosen grades creates (or reuses) the template's grading scale, sets each
 * grade program's scale, result format and rounding (and descriptor scale for descriptive
 * templates), and rebuilds the grade's default subjects on the template's rules and categories.
 * Every write goes through the ordinary configuration services, so their validation, revisions,
 * impact checks and audit entries apply unchanged.
 *
 * Nothing that already exists is changed without `confirm`: a preview lists what would be created,
 * changed or left alone, and an apply that would change existing configuration is refused until it
 * is resent with `confirm`. Subjects with recorded marks, and grade defaults with section-only
 * assessments, are never rebuilt (as with the exam system's "apply to all subjects"); section
 * overrides are left alone. Subjects added to a grade later start from the school's exam system;
 * applying the template again brings them in line.
 */

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface CurriculumTemplateView {
  id: CurriculumTemplateId;
  family: CurriculumFamily;
  name: string;
  description: string;
  grading_method: GradingMethod;
  result_format: ResultFormatKind;
  result_scale_max: number | null;
  max_marks: number;
  pass_percentage: number;
  scale: {
    name: string;
    bands: { label: string; min_percentage: number; gpa_points: number | null }[];
  } | null;
  descriptors: { label: string; points: number | null; not_achieved: boolean }[] | null;
  /** `exam_structure`: the school's exam system from School Settings. */
  categories_source: "exam_structure" | "template";
  categories: {
    name: string;
    kind: CategoryKind;
    weight: number | null;
    aggregation: CategoryAggregation;
    max_marks: number;
  }[];
  subject_credits: { credits: number; average_weight: number } | null;
  course_levels: { label: string; gpa_boost: number }[];
}

function templateView(
  template: CurriculumTemplate,
  locale: TemplateLocale,
): CurriculumTemplateView {
  const { subject } = template;
  return {
    id: template.id,
    family: template.family,
    name: localize(template.name, locale),
    description: localize(template.description, locale),
    grading_method: subject.method,
    result_format: template.resultFormat.format,
    result_scale_max:
      template.resultFormat.format === "percentage" ? null : template.resultFormat.max,
    max_marks: subject.maxMarks,
    pass_percentage: subject.passPercentage,
    scale: template.scale
      ? {
          name: localize(template.scale.name, locale),
          bands: templateScaleBands(template, locale).map((band) => ({
            label: band.label,
            min_percentage: band.minPercentage,
            gpa_points: band.gpaPoints,
          })),
        }
      : null,
    descriptors: template.descriptors
      ? template.descriptors.map((descriptor) => ({
          label: localize(descriptor.label, locale),
          points: descriptor.points,
          not_achieved: descriptor.notAchieved,
        }))
      : null,
    categories_source:
      subject.structure.source === "exam_structure" ? "exam_structure" : "template",
    categories:
      subject.structure.source === "categories"
        ? subject.structure.categories.map((category) => ({
            name: localize(category.name, locale),
            kind: category.kind,
            weight: subject.method === "weighted" ? category.weight : null,
            aggregation: category.aggregation,
            max_marks: category.maxMarks,
          }))
        : [],
    subject_credits: subject.credits
      ? { credits: subject.credits.credits, average_weight: subject.credits.averageWeight }
      : null,
    course_levels: template.courseLevels.map((level) => ({
      label: localize(level.label, locale),
      gpa_boost: level.gpaBoost,
    })),
  };
}

export function listCurriculumTemplates(locale: TemplateLocale): CurriculumTemplateView[] {
  return CURRICULUM_TEMPLATES.map((template) => templateView(template, locale));
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface CurriculumTemplateRequest {
  template_id: CurriculumTemplateId;
  grade_level_ids: string[];
  /** Language of the names the template writes (scale, bands, categories); the school's by default. */
  locale?: TemplateLocale;
}

export type ProgramChange = "grade_scale" | "result_format" | "rounding";
export type TemplateSubjectSkipReason =
  "has_marks" | "section_assessments" | "no_terms" | "invalid";

export interface TemplateSubjectPlan {
  config_id: string;
  subject_id: string;
  subject_name: string;
  action: "update" | "unchanged" | "skip";
  reason: TemplateSubjectSkipReason | null;
  detail: string | null;
}

export interface TemplateGradePlan {
  grade_level_id: string;
  grade_level_name: string;
  program: { action: "create" | "update" | "unchanged"; changes: ProgramChange[] };
  /** Descriptive templates only. */
  descriptors: "create" | "replace" | "unchanged" | null;
  /** Set by an apply when the grade itself could not be set up. */
  error: string | null;
  subjects: TemplateSubjectPlan[];
}

export interface CurriculumTemplatePlan {
  template_id: CurriculumTemplateId;
  template_name: string;
  academic_year_id: string;
  academic_year_name: string;
  locale: TemplateLocale;
  applied: boolean;
  /** True when existing configuration would change: an apply then needs `confirm`. */
  requires_confirmation: boolean;
  scale: {
    action: "create" | "update" | "unchanged";
    scale_id: string | null;
    name: string;
  } | null;
  grades: TemplateGradePlan[];
}

interface ExistingProgram {
  grade_level_id: string;
  grade_scale_id: string | null;
  average_rounding_decimals: number;
  average_rounding_mode: RoundingMode;
  result_format: ResultFormatKind;
  result_scale_max: number | null;
}

/** Everything an apply needs beyond the plan it reports. */
interface BuiltPlan {
  plan: CurriculumTemplatePlan;
  template: CurriculumTemplate;
  bands: GradeBand[];
  descriptors: DescriptorInput[] | null;
  inputs: Map<string, SubjectConfigInput>;
}

const sameBands = (a: readonly GradeBand[], b: readonly GradeBand[]): boolean => {
  const key = (bands: readonly GradeBand[]) =>
    JSON.stringify(
      [...bands]
        .sort((x, y) => x.minPercentage - y.minPercentage)
        .map((band) => [band.label, band.minPercentage, band.gpaPoints]),
    );
  return key(a) === key(b);
};

/** The term structure every subject of the template gets in this year. */
function subjectStructure(
  template: CurriculumTemplate,
  terms: readonly TermRow[],
  examSettings: SchoolExamSettings,
  locale: TemplateLocale,
): Pick<SubjectConfigInput, "term_weights" | "categories" | "assessments"> {
  const { structure, method } = template.subject;
  if (structure.source === "exam_structure") {
    const exam = buildExamTemplate(
      examSettings.exam_structure,
      examSettings.exam_weights,
      terms.map((term) => term.id),
      locale,
    );
    return {
      term_weights: exam.term_weights,
      categories: exam.categories,
      assessments: exam.assessments,
    };
  }
  const built = buildTemplateTermStructure(method, structure.categories, terms.length, locale);
  return {
    term_weights: built.termWeights.map((weight, index) => ({
      term_id: terms.at(index)!.id,
      weight,
    })),
    categories: built.categories.map((category) => ({
      ref: category.key,
      name: category.name,
      kind: category.kind,
      scope: "term",
      weight: category.weight,
      aggregation: category.aggregation,
      drop_lowest: 0,
      sort_order: category.sortOrder,
    })),
    assessments: built.assessments.map((assessment) => ({
      category_ref: assessment.categoryKey,
      term_id: terms.at(assessment.termIndex)!.id,
      name: assessment.name,
      max_marks: assessment.maxMarks,
      weight: 1,
      is_mandatory: true,
      assessment_date: null,
      due_date: null,
      sort_order: assessment.sortOrder,
    })),
  };
}

/** A subject's current rules and grade-wide structure as a save input. */
function inputFromView(view: ConfigView): SubjectConfigInput {
  return {
    requirement: view.requirement,
    include_in_average: view.include_in_average,
    include_on_certificate: view.include_on_certificate,
    average_weight: view.average_weight,
    credits: view.credits,
    course_level: view.course_level,
    gpa_boost: view.gpa_boost,
    grading_method: view.grading_method,
    max_marks: view.max_marks,
    pass_percentage: view.pass_percentage,
    final_exam_pass_percentage: view.final_exam_pass_percentage,
    grade_scale_id: view.grade_scale_id,
    rounding_decimals: view.rounding_decimals,
    rounding_mode: view.rounding_mode,
    missing_mark_policy: view.missing_mark_policy,
    absent_policy: view.absent_policy,
    retake_policy: view.retake_policy,
    retake_cap_percentage: view.retake_cap_percentage,
    teachers_can_add_assessments: view.teachers_can_add_assessments,
    teacher_assessments_require_approval: view.teacher_assessments_require_approval,
    instructions: view.instructions,
    term_weights: view.term_weights.map(({ term_id, weight }) => ({ term_id, weight })),
    categories: view.categories.map((category) => ({ ...category, ref: category.id })),
    assessments: view.assessments
      .filter((assessment) => assessment.section_id === null && assessment.status === "active")
      .map((assessment) => ({
        id: assessment.id,
        category_ref: assessment.category_id,
        term_id: assessment.term_id,
        name: assessment.name,
        max_marks: assessment.max_marks,
        weight: assessment.weight,
        is_mandatory: assessment.is_mandatory,
        assessment_date: assessment.assessment_date,
        due_date: assessment.due_date,
        sort_order: assessment.sort_order,
      })),
  };
}

/** The subject on the template's rules, keeping what the template does not set. */
function templateInput(
  view: ConfigView,
  template: CurriculumTemplate,
  structure: Pick<SubjectConfigInput, "term_weights" | "categories" | "assessments">,
): SubjectConfigInput {
  const { subject } = template;
  const current = inputFromView(view);
  return normalizeDescriptiveInput({
    ...current,
    // A descriptive subject never counts in the average; one turned numeric counts again.
    include_in_average:
      view.grading_method === "descriptive" && subject.method !== "descriptive"
        ? true
        : view.include_in_average,
    average_weight: subject.credits?.averageWeight ?? view.average_weight,
    credits: subject.credits ? subject.credits.credits : view.credits,
    grading_method: subject.method,
    max_marks: subject.maxMarks,
    pass_percentage: subject.passPercentage,
    // A final-exam pass mark only makes sense while the structure still has a final exam.
    final_exam_pass_percentage: structure.categories.some((c) => c.kind === "final_exam")
      ? view.final_exam_pass_percentage
      : null,
    // Subjects take the grade's scale, which the template sets.
    grade_scale_id: null,
    rounding_decimals: subject.rounding.decimals,
    rounding_mode: subject.rounding.mode,
    ...structure,
  });
}

/** What a save would make of a subject, without ids, dates or ordering noise. */
function subjectShape(input: SubjectConfigInput): string {
  const categories = [...input.categories].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
  );
  const index = new Map(categories.map((category, position) => [category.ref, position]));
  return JSON.stringify({
    rules: [
      input.requirement,
      input.include_in_average,
      input.include_on_certificate,
      input.average_weight,
      input.credits ?? null,
      input.course_level ?? null,
      input.gpa_boost ?? 0,
      input.grading_method,
      input.max_marks,
      input.pass_percentage,
      input.final_exam_pass_percentage,
      input.grade_scale_id,
      input.rounding_decimals,
      input.rounding_mode,
      input.retake_policy,
      input.retake_cap_percentage,
    ],
    terms: input.term_weights
      .filter((row) => row.weight > 0)
      .map((row) => [row.term_id, row.weight])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    categories: categories.map((category) => [
      category.name,
      category.kind,
      category.scope,
      category.weight,
      category.aggregation,
      category.drop_lowest,
    ]),
    assessments: input.assessments
      .map((assessment) =>
        JSON.stringify([
          index.get(assessment.category_ref) ?? -1,
          assessment.term_id,
          assessment.name,
          assessment.max_marks,
          assessment.weight,
          assessment.is_mandatory,
        ]),
      )
      .sort(),
  });
}

function skipReason(view: ConfigView, terms: readonly TermRow[]): TemplateSubjectSkipReason | null {
  if (view.mark_count > 0) return "has_marks";
  if (view.assessments.some((assessment) => assessment.section_id !== null)) {
    return "section_assessments";
  }
  if (terms.length === 0) return "no_terms";
  return null;
}

async function buildPlan(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  request: CurriculumTemplateRequest,
): Promise<BuiltPlan> {
  const template = getCurriculumTemplate(request.template_id);
  if (!template) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Template not found");
  }
  const year = await requireYear(tx, schoolId, yearId);
  assertConfigEditable(year);
  const examSettings = await loadExamSettings(tx, schoolId);
  const locale: TemplateLocale =
    request.locale ?? (examSettings.locale.toLowerCase().startsWith("ar") ? "ar" : "en");

  const gradeIds = [...new Set(request.grade_level_ids)];
  const grades = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM app.grade_levels
    WHERE school_id = ${schoolId}::uuid AND id = ANY (${gradeIds}::uuid[]) AND archived_at IS NULL
    ORDER BY sort_order, name
  `;
  if (grades.length !== gradeIds.length) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Grade level not found");
  }

  // The scale: the template's, by name, in the year.
  const bands = templateScaleBands(template, locale);
  let scale: CurriculumTemplatePlan["scale"] = null;
  if (template.scale) {
    const name = localize(template.scale.name, locale);
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM app.grade_scales
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid AND name = ${name}
    `;
    scale = existing
      ? {
          action: sameBands((await loadScale(tx, schoolId, existing.id)).bands, bands)
            ? "unchanged"
            : "update",
          scale_id: existing.id,
          name,
        }
      : { action: "create", scale_id: null, name };
  }

  const descriptors: DescriptorInput[] | null = template.descriptors
    ? template.descriptors.map((descriptor) => ({
        label: localize(descriptor.label, locale),
        points: descriptor.points,
        not_achieved: descriptor.notAchieved,
      }))
    : null;
  const descriptorRows = descriptors
    ? await loadDescriptorRows(tx, schoolId, yearId, gradeIds)
    : [];

  const programs = await tx<ExistingProgram[]>`
    SELECT grade_level_id, grade_scale_id, average_rounding_decimals, average_rounding_mode,
           result_format, result_scale_max::float8 AS result_scale_max
    FROM app.grade_programs
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
      AND grade_level_id = ANY (${gradeIds}::uuid[])
  `;
  const programByGrade = new Map(programs.map((program) => [program.grade_level_id, program]));
  const terms = await loadYearTerms(tx, schoolId, yearId);
  const structure = subjectStructure(template, terms, examSettings, locale);
  const format = template.resultFormat;
  const formatMax = format.format === "percentage" ? null : format.max;

  const inputs = new Map<string, SubjectConfigInput>();
  const gradePlans: TemplateGradePlan[] = [];
  for (const grade of grades) {
    const existing = programByGrade.get(grade.id);
    const changes: ProgramChange[] = [];
    if (existing) {
      if (scale && (scale.scale_id === null || existing.grade_scale_id !== scale.scale_id)) {
        changes.push("grade_scale");
      }
      if (existing.result_format !== format.format || existing.result_scale_max !== formatMax) {
        changes.push("result_format");
      }
      if (
        existing.average_rounding_decimals !== template.overallRounding.decimals ||
        existing.average_rounding_mode !== template.overallRounding.mode
      ) {
        changes.push("rounding");
      }
    }

    let descriptorAction: TemplateGradePlan["descriptors"] = null;
    if (descriptors) {
      const current = descriptorRows
        .filter((row) => row.grade_level_id === grade.id)
        .sort((a, b) => a.position - b.position)
        .map((row) => [
          row.label,
          row.points === null ? null : Number(row.points),
          row.not_achieved,
        ]);
      const wanted = descriptors.map((d) => [d.label, d.points, d.not_achieved]);
      descriptorAction =
        current.length === 0
          ? "create"
          : JSON.stringify(current) === JSON.stringify(wanted)
            ? "unchanged"
            : "replace";
    }

    const subjects: TemplateSubjectPlan[] = [];
    // A grade without a program has no subjects yet.
    for (const view of existing ? await listGradeConfigs(tx, schoolId, yearId, grade.id) : []) {
      const base = {
        config_id: view.id,
        subject_id: view.subject.id,
        subject_name: view.subject.name,
        detail: null,
      };
      const reason = skipReason(view, terms);
      if (reason) {
        subjects.push({ ...base, action: "skip", reason });
        continue;
      }
      const input = templateInput(view, template, structure);
      const unchanged = subjectShape(input) === subjectShape(inputFromView(view));
      if (!unchanged) inputs.set(view.id, input);
      subjects.push({ ...base, action: unchanged ? "unchanged" : "update", reason: null });
    }

    gradePlans.push({
      grade_level_id: grade.id,
      grade_level_name: grade.name,
      program: {
        action: !existing ? "create" : changes.length > 0 ? "update" : "unchanged",
        changes,
      },
      descriptors: descriptorAction,
      error: null,
      subjects,
    });
  }

  const requiresConfirmation =
    scale?.action === "update" ||
    gradePlans.some(
      (grade) =>
        grade.program.action === "update" ||
        grade.descriptors === "replace" ||
        grade.subjects.some((subject) => subject.action === "update"),
    );

  return {
    plan: {
      template_id: template.id,
      template_name: localize(template.name, locale),
      academic_year_id: year.id,
      academic_year_name: year.name,
      locale,
      applied: false,
      requires_confirmation: requiresConfirmation,
      scale,
      grades: gradePlans,
    },
    template,
    bands,
    descriptors,
    inputs,
  };
}

/** What applying a template to the year's chosen grades would create, change or leave alone. */
export async function previewCurriculumTemplate(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  request: CurriculumTemplateRequest,
): Promise<CurriculumTemplatePlan> {
  return (await buildPlan(tx, schoolId, yearId, request)).plan;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyCurriculumTemplate(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  yearId: string,
  request: CurriculumTemplateRequest & { confirm?: boolean },
): Promise<CurriculumTemplatePlan> {
  const { plan, template, bands, descriptors, inputs } = await buildPlan(
    tx,
    schoolId,
    yearId,
    request,
  );
  if (plan.requires_confirmation && request.confirm !== true) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ACADEMIC_CONFIG_IMPACT_UNCONFIRMED,
      `Applying ${plan.template_name} would change existing grading configuration in ${plan.academic_year_name}. Review the preview and confirm to continue.`,
    );
  }

  // The scale first: every grade points at it.
  let scaleId = plan.scale?.scale_id ?? null;
  const scaleBody = { name: plan.scale?.name ?? "", bands: bandsBody(bands) };
  if (plan.scale?.action === "create") {
    scaleId = (await createScale(tx, schoolId, yearId, scaleBody)).id;
    plan.scale.scale_id = scaleId;
  } else if (plan.scale?.action === "update") {
    await updateScale(tx, schoolId, scaleId!, scaleBody);
  }

  const format = template.resultFormat;
  for (const grade of plan.grades) {
    const programInput: ProgramInput = {
      ...(template.scale ? { grade_scale_id: scaleId } : {}),
      result_format: format.format,
      result_scale_max: format.format === "percentage" ? null : format.max,
      average_rounding_decimals: template.overallRounding.decimals,
      average_rounding_mode: template.overallRounding.mode,
      ...(descriptors && grade.descriptors !== "unchanged" ? { descriptors } : {}),
    };
    if (
      grade.program.action !== "unchanged" ||
      (grade.descriptors !== null && grade.descriptors !== "unchanged")
    ) {
      // Each grade saves on its own savepoint: one the rules refuse (a descriptor in use) is
      // reported and the others still go through.
      try {
        await tx.savepoint((sp) =>
          upsertProgram(sp, schoolId, yearId, grade.grade_level_id, programInput),
        );
      } catch (error) {
        if (!(error instanceof CodedHttpException)) throw error;
        grade.error = error.message;
        for (const subject of grade.subjects) {
          if (subject.action === "update") {
            Object.assign(subject, { action: "skip", reason: "invalid", detail: error.message });
          }
        }
        continue;
      }
    }

    for (const subject of grade.subjects) {
      if (subject.action !== "update") continue;
      try {
        await tx.savepoint((sp) =>
          updateSubjectConfig(
            sp,
            schoolId,
            userId,
            subject.config_id,
            inputs.get(subject.config_id)!,
            {
              confirmImpact: false,
            },
          ),
        );
      } catch (error) {
        if (!(error instanceof CodedHttpException)) throw error;
        Object.assign(subject, { action: "skip", reason: "invalid", detail: error.message });
      }
    }
  }

  plan.applied = true;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_programs",
    targetId: yearId,
    newValues: {
      event: "curriculum_template_applied",
      template_id: template.id,
      locale: plan.locale,
      confirmed: request.confirm === true,
      scale: plan.scale ? { action: plan.scale.action, scale_id: plan.scale.scale_id } : null,
      grades: plan.grades.map((grade) => ({
        grade_level_id: grade.grade_level_id,
        program: grade.program.action,
        descriptors: grade.descriptors,
        error: grade.error,
        updated: grade.subjects.filter((s) => s.action === "update").map((s) => s.config_id),
        skipped: grade.subjects
          .filter((s) => s.action === "skip")
          .map((s) => ({ id: s.config_id, reason: s.reason })),
      })),
    },
  });
  return plan;
}

function bandsBody(bands: readonly GradeBand[]) {
  return bands.map((band) => ({
    label: band.label,
    min_percentage: band.minPercentage,
    gpa_points: band.gpaPoints,
  }));
}
