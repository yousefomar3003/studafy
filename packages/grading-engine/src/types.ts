/**
 * The grading engine's input and output shapes.
 *
 * Every number is a plain JavaScript number. Percentages are on a 0-100 scale. The engine never
 * reads the database: the API resolves a section's effective configuration and marks, hands them
 * here, and stores what comes back. The same `SubjectGradingConfig` object is what a finalized
 * result snapshots, so a historical result can always be recomputed with the rules it was
 * finalized under.
 */

/** How a subject's period grade is built from its categories. */
export type GradingMethod =
  /** Each category's percentage is multiplied by its weight; weights total 100. */
  | "weighted"
  /** Every counted mark's points are summed and divided by the summed maximums. Weights unused. */
  | "total_points";

/** How a category turns its assessments into one percentage before its weight is applied. */
export type CategoryAggregation =
  /** Mean of the assessment percentages, weighted by each assessment's relative weight. */
  | "weighted_average"
  /** Sum of points over sum of maximums inside the category. */
  | "total_points";

export type CategoryKind =
  | "homework"
  | "quiz"
  | "classwork"
  | "project"
  | "practical"
  | "participation"
  | "exam"
  | "midterm"
  | "final_exam"
  | "other";

/** `term` categories build each term's grade; `annual` categories feed the annual grade directly. */
export type CategoryScope = "term" | "annual";

export type RoundingMode = "half_up" | "half_even" | "floor" | "ceil";

export interface RoundingRule {
  /** Decimal places kept on a displayed or finalized percentage (0-4). */
  decimals: number;
  mode: RoundingMode;
}

/** What a recorded mark says. A mark that has not been recorded at all is "pending". */
export type MarkStatus = "graded" | "absent" | "excused" | "not_applicable";

/** School policy for a mandatory assessment with no mark at all. */
export type MissingMarkPolicy = "incomplete" | "zero";

/** School policy for an assessment the student was absent from (unexcused). */
export type AbsentPolicy = "incomplete" | "zero";

/** How a retake / supplementary attempt combines with the original attempt. */
export type RetakePolicy = "none" | "replace" | "highest" | "capped";

export interface GradeBand {
  label: string;
  /** Inclusive lower bound. A band runs up to (not including) the next band's lower bound. */
  minPercentage: number;
  gpaPoints: number | null;
}

export interface EngineTerm {
  termId: string;
  name: string;
  sequence: number;
  /** Share of the annual grade this term's grade carries (weighted method). */
  weight: number;
}

export interface EngineCategory {
  id: string;
  name: string;
  kind: CategoryKind;
  scope: CategoryScope;
  /** Share of the period grade (weighted method). Ignored for total_points. */
  weight: number | null;
  aggregation: CategoryAggregation;
  /** Lowest N assessment percentages dropped before aggregating (per term). */
  dropLowest: number;
}

export interface EngineAssessment {
  id: string;
  categoryId: string;
  /** The term a `term`-scope assessment belongs to; null for `annual`-scope assessments. */
  termId: string | null;
  name: string;
  maxMarks: number;
  /** Relative weight inside its category (weighted_average aggregation). */
  weight: number;
  /** A mandatory assessment without a mark makes the result incomplete (or zero, per policy). */
  mandatory: boolean;
}

export interface SubjectGradingConfig {
  method: GradingMethod;
  /** The scale marks are reported on (e.g. 100): the subject's percentage times this over 100. */
  maxMarks: number;
  passPercentage: number;
  /** When set, every final-exam category in scope must reach this percentage on its own. */
  finalExamPassPercentage: number | null;
  rounding: RoundingRule;
  missingPolicy: MissingMarkPolicy;
  absentPolicy: AbsentPolicy;
  retakePolicy: RetakePolicy;
  /** For `capped`: a retake counts for at most this percentage. */
  retakeCapPercentage: number | null;
  scale: GradeBand[];
  terms: EngineTerm[];
  categories: EngineCategory[];
  assessments: EngineAssessment[];
}

export interface MarkInput {
  assessmentId: string;
  /** 1 = the original sitting, 2 = a retake / supplementary sitting. */
  attempt: 1 | 2;
  status: MarkStatus;
  /** Raw points, 0..maxMarks. Required when status is `graded`, null otherwise. */
  score: number | null;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** How one assessment ended up counting. */
export type AssessmentState = "counted" | "defaulted_zero" | "excluded" | "missing" | "dropped";

export interface AssessmentOutcome {
  assessmentId: string;
  name: string;
  state: AssessmentState;
  /** Effective percentage after any retake rule; null when not counted. */
  percentage: number | null;
  /** Effective points (percentage of maxMarks); null when not counted. */
  points: number | null;
  maxMarks: number;
  usedRetake: boolean;
}

export interface CategoryOutcome {
  categoryId: string;
  name: string;
  kind: CategoryKind;
  scope: CategoryScope;
  termId: string | null;
  /** Configured weight, before redistribution. */
  weight: number | null;
  /** Unrounded category percentage; null when nothing counted. */
  percentage: number | null;
  /** True when every assessment was excused / not applicable: its weight is redistributed. */
  empty: boolean;
  incomplete: boolean;
  assessments: AssessmentOutcome[];
}

export interface PeriodOutcome {
  termId: string | null;
  /** Unrounded percentage over what counted; present even when incomplete, for previews only. */
  provisionalPercentage: number | null;
  /** Rounded percentage; null when the period is incomplete or has nothing to grade. */
  percentage: number | null;
  incomplete: boolean;
  categories: CategoryOutcome[];
}

export interface SubjectResult {
  /** `complete`: every required mark is in. `incomplete`: never a verified final grade. */
  status: "complete" | "incomplete";
  /** Null when the scope being computed is a single term; otherwise the annual breakdown. */
  termId: string | null;
  /** Rounded subject percentage; null when incomplete or nothing to grade. */
  percentage: number | null;
  /** For teacher previews: unrounded percentage over what has been marked so far. */
  provisionalPercentage: number | null;
  /** percentage x maxMarks / 100, rounded with the same rule; null when percentage is. */
  marksObtained: number | null;
  maxMarks: number;
  gradeLabel: string | null;
  gpaPoints: number | null;
  /** Null when incomplete: pass/fail is only decided on a complete result. */
  passed: boolean | null;
  failReasons: FailReason[];
  /** Mandatory assessments still without a usable mark. */
  missingAssessments: { assessmentId: string; name: string }[];
  terms: PeriodOutcome[];
  /** Annual-scope categories (annual computation only). */
  annualCategories: CategoryOutcome[];
}

export type FailReason =
  | { code: "BELOW_PASS_PERCENTAGE"; required: number; actual: number }
  | {
      code: "FINAL_EXAM_BELOW_REQUIRED";
      categoryId: string;
      required: number;
      actual: number | null;
    };

export type SubjectRequirement = "mandatory" | "optional" | "elective";

/** One subject's outcome as the overall calculation sees it. */
export interface SubjectOutcomeForOverall {
  subjectId: string;
  requirement: SubjectRequirement;
  includeInAverage: boolean;
  /** Coefficient in the overall average (1 for a plain mean). */
  averageWeight: number;
  exempt: boolean;
  result: SubjectResult | null;
}

export interface OverallPolicy {
  rounding: RoundingRule;
  /** Failing more than this many counted subjects means `retained`; up to it, `supplementary`. */
  maxFailedSubjectsForSupplementary: number;
  /** Optional scale for an overall grade label. */
  scale: GradeBand[] | null;
}

export type AcademicStatus = "promoted" | "supplementary" | "retained" | "incomplete";

export interface OverallResult {
  status: "complete" | "incomplete";
  averagePercentage: number | null;
  totalObtained: number | null;
  totalMax: number | null;
  gradeLabel: string | null;
  subjectsFailed: number;
  failedSubjectIds: string[];
  incompleteSubjectIds: string[];
  academicStatus: AcademicStatus;
}

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  message: string;
  /** What the issue is about: a category, assessment, term or band id, when there is one. */
  ref?: string;
}

export interface WeightSummary {
  /** Sum of `term`-scope category weights (weighted method); must be 100 when any exist. */
  termCategoryTotal: number;
  /** Sum of term weights plus `annual`-scope category weights; must be 100. */
  annualTotal: number;
  valid: boolean;
}
