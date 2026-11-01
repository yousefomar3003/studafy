import { summarizeWeights, validateSubjectConfig } from "@studafy/grading-engine";

import type {
  CreateSubjectConfigBody,
  ExamTemplate,
  SubjectConfig,
  UpdateSubjectConfigBody,
} from "./queries";
import type { Term } from "../../admin/timetable/queries";
import type { SubjectGradingConfig, ValidationIssue, WeightSummary } from "@studafy/grading-engine";

/**
 * The subject configuration editor's form model, and the pure conversions around it: from a saved
 * {@link SubjectConfig}, to the API body, and to the grading engine's input for live validation.
 * Numbers stay strings while being edited so a half-typed field ("", "12.") never snaps back.
 */

export type Requirement = SubjectConfig["requirement"];
export type GradingMethod = SubjectConfig["grading_method"];
export type RoundingMode = SubjectConfig["rounding_mode"];
export type MissingPolicy = SubjectConfig["missing_mark_policy"];
export type RetakePolicy = SubjectConfig["retake_policy"];
export type CategoryKind = SubjectConfig["categories"][number]["kind"];
export type CategoryScope = SubjectConfig["categories"][number]["scope"];
export type Aggregation = SubjectConfig["categories"][number]["aggregation"];

export const REQUIREMENTS: readonly Requirement[] = ["mandatory", "optional", "elective"];
export const GRADING_METHODS: readonly GradingMethod[] = ["weighted", "total_points"];
export const ROUNDING_MODES: readonly RoundingMode[] = ["half_up", "half_even", "floor", "ceil"];
export const MISSING_POLICIES: readonly MissingPolicy[] = ["incomplete", "zero"];
export const RETAKE_POLICIES: readonly RetakePolicy[] = ["none", "replace", "highest", "capped"];
export const CATEGORY_KINDS: readonly CategoryKind[] = [
  "homework",
  "quiz",
  "classwork",
  "project",
  "practical",
  "participation",
  "exam",
  "first_period",
  "second_period",
  "midterm",
  "final_exam",
  "other",
];
export const CATEGORY_SCOPES: readonly CategoryScope[] = ["term", "annual"];
export const AGGREGATIONS: readonly Aggregation[] = ["weighted_average", "total_points"];

export interface CategoryDraft {
  /** Stable key for React and for assessments to point at; the saved id for existing categories. */
  key: string;
  /** Saved category id, or null for one added in this edit. */
  id: string | null;
  name: string;
  kind: CategoryKind;
  scope: CategoryScope;
  weight: string;
  aggregation: Aggregation;
  dropLowest: string;
}

export interface AssessmentDraft {
  key: string;
  /** Saved assessment id (its marks stay attached), or null for a new one. */
  id: string | null;
  categoryKey: string;
  termId: string | null;
  name: string;
  maxMarks: string;
  weight: string;
  mandatory: boolean;
  assessmentDate: string;
  dueDate: string;
  /** Marks already recorded against it; such an assessment cannot be removed. */
  markCount: number;
  status: SubjectConfig["assessments"][number]["status"];
}

export interface ConfigDraft {
  requirement: Requirement;
  includeInAverage: boolean;
  includeOnCertificate: boolean;
  averageWeight: string;
  gradingMethod: GradingMethod;
  maxMarks: string;
  passPercentage: string;
  /** "" means no separate final-exam requirement. */
  finalExamPassPercentage: string;
  /** "" means the grade's default scale. */
  gradeScaleId: string;
  roundingDecimals: string;
  roundingMode: RoundingMode;
  missingPolicy: MissingPolicy;
  absentPolicy: MissingPolicy;
  retakePolicy: RetakePolicy;
  retakeCapPercentage: string;
  teachersCanAddAssessments: boolean;
  teacherAssessmentsRequireApproval: boolean;
  instructions: string;
  /** Term id -> weight in the annual grade. */
  termWeights: Record<string, string>;
  categories: CategoryDraft[];
  assessments: AssessmentDraft[];
}

let sequence = 0;
/** A client-side key for a new row; the API accepts any string as a new category's `ref`. */
export function newKey(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

const str = (value: number | null | undefined): string =>
  value === null || value === undefined ? "" : String(value);

/** An empty draft for a new subject: one 100% term category, terms weighted equally. */
export function emptyDraft(terms: readonly Pick<Term, "id">[]): ConfigDraft {
  const share = terms.length > 0 ? Math.floor((100 / terms.length) * 100) / 100 : 0;
  const termWeights: Record<string, string> = {};
  terms.forEach((term, index) => {
    // The last term takes the rounding remainder so the total is exactly 100.
    termWeights[term.id] =
      index === terms.length - 1 ? str(Math.round((100 - share * index) * 100) / 100) : str(share);
  });
  return {
    requirement: "mandatory",
    includeInAverage: true,
    includeOnCertificate: true,
    averageWeight: "1",
    gradingMethod: "weighted",
    maxMarks: "100",
    passPercentage: "50",
    finalExamPassPercentage: "",
    gradeScaleId: "",
    roundingDecimals: "2",
    roundingMode: "half_up",
    missingPolicy: "incomplete",
    absentPolicy: "incomplete",
    retakePolicy: "none",
    retakeCapPercentage: "",
    teachersCanAddAssessments: false,
    teacherAssessmentsRequireApproval: true,
    instructions: "",
    termWeights,
    categories: [],
    assessments: [],
  };
}

/**
 * A new subject's draft on the school's exam system: the template's term weights, one category per
 * part and one assessment per part per term. Every field stays editable before saving.
 */
export function draftFromTemplate(
  terms: readonly Pick<Term, "id">[],
  template: ExamTemplate,
): ConfigDraft {
  const draft = emptyDraft(terms);
  const keys = new Map(template.categories.map((category) => [category.ref, newKey("category")]));
  return {
    ...draft,
    termWeights: Object.fromEntries(
      template.term_weights.map((term) => [term.term_id, str(term.weight)]),
    ),
    categories: template.categories.map((category) => ({
      key: keys.get(category.ref)!,
      id: null,
      name: category.name,
      kind: category.kind,
      scope: category.scope,
      weight: str(category.weight),
      aggregation: category.aggregation,
      dropLowest: str(category.drop_lowest),
    })),
    assessments: template.assessments.map((assessment) => ({
      key: newKey("assessment"),
      id: null,
      categoryKey: keys.get(assessment.category_ref)!,
      termId: assessment.term_id,
      name: assessment.name,
      maxMarks: str(assessment.max_marks),
      weight: str(assessment.weight),
      mandatory: assessment.is_mandatory,
      assessmentDate: assessment.assessment_date ?? "",
      dueDate: assessment.due_date ?? "",
      markCount: 0,
      status: "active",
    })),
  };
}

/**
 * The draft for an existing configuration. On a grade default, assessments a single section added
 * on its own are managed from that section and are not part of this edit (the API leaves them be).
 */
export function draftFromConfig(config: SubjectConfig): ConfigDraft {
  const termWeights: Record<string, string> = {};
  for (const row of config.term_weights) termWeights[row.term_id] = str(row.weight);
  const ownAssessments = config.assessments.filter(
    (assessment) => config.section_id !== null || assessment.section_id === null,
  );
  return {
    requirement: config.requirement,
    includeInAverage: config.include_in_average,
    includeOnCertificate: config.include_on_certificate,
    averageWeight: str(config.average_weight),
    gradingMethod: config.grading_method,
    maxMarks: str(config.max_marks),
    passPercentage: str(config.pass_percentage),
    finalExamPassPercentage: str(config.final_exam_pass_percentage),
    gradeScaleId: config.grade_scale_id ?? "",
    roundingDecimals: str(config.rounding_decimals),
    roundingMode: config.rounding_mode,
    missingPolicy: config.missing_mark_policy,
    absentPolicy: config.absent_policy,
    retakePolicy: config.retake_policy,
    retakeCapPercentage: str(config.retake_cap_percentage),
    teachersCanAddAssessments: config.teachers_can_add_assessments,
    teacherAssessmentsRequireApproval: config.teacher_assessments_require_approval,
    instructions: config.instructions ?? "",
    termWeights,
    categories: [...config.categories]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((category) => ({
        key: category.id,
        id: category.id,
        name: category.name,
        kind: category.kind,
        scope: category.scope,
        weight: str(category.weight),
        aggregation: category.aggregation,
        dropLowest: str(category.drop_lowest),
      })),
    assessments: [...ownAssessments]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((assessment) => ({
        key: assessment.id,
        id: assessment.id,
        categoryKey: assessment.category_id,
        termId: assessment.term_id,
        name: assessment.name,
        maxMarks: str(assessment.max_marks),
        weight: str(assessment.weight),
        mandatory: assessment.is_mandatory,
        assessmentDate: assessment.assessment_date ?? "",
        dueDate: assessment.due_date ?? "",
        markCount: assessment.mark_count,
        status: assessment.status,
      })),
  };
}

export function newCategory(scope: CategoryScope = "term"): CategoryDraft {
  return {
    key: newKey("category"),
    id: null,
    name: "",
    kind: "exam",
    scope,
    weight: "",
    aggregation: "weighted_average",
    dropLowest: "0",
  };
}

export function newAssessment(category: CategoryDraft, termId: string | null): AssessmentDraft {
  return {
    key: newKey("assessment"),
    id: null,
    categoryKey: category.key,
    termId: category.scope === "annual" ? null : termId,
    name: "",
    maxMarks: "100",
    weight: "1",
    mandatory: true,
    assessmentDate: "",
    dueDate: "",
    markCount: 0,
    status: "active",
  };
}

/** A number typed into the form; blank or unparsable text reads as NaN so validation flags it. */
export function toNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function optionalNumber(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

/** The draft as the engine sees it: the same check the API runs before it saves. */
export function draftToEngine(
  draft: ConfigDraft,
  terms: readonly Pick<Term, "id" | "name" | "sequence_number">[],
): SubjectGradingConfig {
  return {
    method: draft.gradingMethod,
    maxMarks: toNumber(draft.maxMarks),
    passPercentage: toNumber(draft.passPercentage),
    finalExamPassPercentage: optionalNumber(draft.finalExamPassPercentage),
    rounding: { decimals: toNumber(draft.roundingDecimals), mode: draft.roundingMode },
    missingPolicy: draft.missingPolicy,
    absentPolicy: draft.absentPolicy,
    retakePolicy: draft.retakePolicy,
    retakeCapPercentage: optionalNumber(draft.retakeCapPercentage),
    // The scale is validated on its own screen; an empty one here skips re-reporting its issues.
    scale: [],
    terms: terms.map((term) => ({
      termId: term.id,
      name: term.name,
      sequence: term.sequence_number,
      weight: optionalNumber(draft.termWeights[term.id] ?? "") ?? 0,
    })),
    categories: draft.categories.map((category) => ({
      id: category.key,
      name: category.name,
      kind: category.kind,
      scope: category.scope,
      weight: optionalNumber(category.weight),
      aggregation: category.aggregation,
      dropLowest: toNumber(category.dropLowest),
    })),
    assessments: draft.assessments.map((assessment) => ({
      id: assessment.key,
      categoryId: assessment.categoryKey,
      termId: assessment.termId,
      name: assessment.name,
      maxMarks: toNumber(assessment.maxMarks),
      weight: toNumber(assessment.weight),
      mandatory: assessment.mandatory,
    })),
  };
}

export interface LiveValidation {
  summary: WeightSummary;
  issues: ValidationIssue[];
}

export function validateDraft(
  draft: ConfigDraft,
  terms: readonly Pick<Term, "id" | "name" | "sequence_number">[],
): LiveValidation {
  const engine = draftToEngine(draft, terms);
  return { summary: summarizeWeights(engine), issues: validateSubjectConfig(engine) };
}

type ConfigBody = Omit<UpdateSubjectConfigBody, "confirm_impact" | "expected_updated_at">;

/** The API body. Existing categories and assessments are referenced by id so marks stay attached. */
export function draftToBody(draft: ConfigDraft): ConfigBody {
  const categoryRef = new Map(draft.categories.map((c) => [c.key, c.id ?? c.key]));
  return {
    requirement: draft.requirement,
    include_in_average: draft.includeInAverage,
    include_on_certificate: draft.includeOnCertificate,
    average_weight: toNumber(draft.averageWeight),
    grading_method: draft.gradingMethod,
    max_marks: toNumber(draft.maxMarks),
    pass_percentage: toNumber(draft.passPercentage),
    final_exam_pass_percentage: optionalNumber(draft.finalExamPassPercentage),
    grade_scale_id: draft.gradeScaleId === "" ? null : draft.gradeScaleId,
    rounding_decimals: toNumber(draft.roundingDecimals),
    rounding_mode: draft.roundingMode,
    missing_mark_policy: draft.missingPolicy,
    absent_policy: draft.absentPolicy,
    retake_policy: draft.retakePolicy,
    retake_cap_percentage:
      draft.retakePolicy === "capped" ? optionalNumber(draft.retakeCapPercentage) : null,
    teachers_can_add_assessments: draft.teachersCanAddAssessments,
    teacher_assessments_require_approval: draft.teacherAssessmentsRequireApproval,
    instructions: draft.instructions.trim() === "" ? null : draft.instructions.trim(),
    term_weights: Object.entries(draft.termWeights)
      .filter(([, weight]) => weight.trim() !== "")
      .map(([term_id, weight]) => ({ term_id, weight: Number(weight) })),
    categories: draft.categories.map((category, index) => ({
      ref: category.id ?? category.key,
      name: category.name.trim(),
      kind: category.kind,
      scope: category.scope,
      weight: optionalNumber(category.weight),
      aggregation: category.aggregation,
      drop_lowest: toNumber(category.dropLowest),
      sort_order: index,
    })),
    assessments: draft.assessments.map((assessment, index) => ({
      ...(assessment.id ? { id: assessment.id } : {}),
      category_ref: categoryRef.get(assessment.categoryKey) ?? assessment.categoryKey,
      term_id: assessment.termId,
      name: assessment.name.trim(),
      max_marks: toNumber(assessment.maxMarks),
      weight: toNumber(assessment.weight),
      is_mandatory: assessment.mandatory,
      assessment_date: assessment.assessmentDate === "" ? null : assessment.assessmentDate,
      due_date: assessment.dueDate === "" ? null : assessment.dueDate,
      sort_order: index,
    })),
  };
}

export function draftToCreateBody(
  draft: ConfigDraft,
  subjectId: string,
  sectionId: string | null,
): CreateSubjectConfigBody {
  return { ...draftToBody(draft), subject_id: subjectId, section_id: sectionId };
}

/**
 * Fields the API requires as numbers (it rejects the whole body otherwise), and names that cannot
 * be blank. Weight-like fields left blank are not counted here: the engine reports those.
 */
export function hasIncompleteFields(draft: ConfigDraft): boolean {
  const invalid = (value: string) => !Number.isFinite(toNumber(value));
  return (
    invalid(draft.averageWeight) ||
    invalid(draft.maxMarks) ||
    invalid(draft.passPercentage) ||
    invalid(draft.roundingDecimals) ||
    draft.categories.some((c) => c.name.trim() === "" || invalid(c.dropLowest)) ||
    draft.assessments.some((a) => a.name.trim() === "" || invalid(a.maxMarks) || invalid(a.weight))
  );
}

/** Totals shown to the user, rounded so float noise (33.33 * 3) never reads as "99.99000001". */
export function displayTotal(value: number): number {
  return Math.round(value * 100) / 100;
}
