import { atLeast, matchBand, roundTo } from "./rounding";

import type {
  AssessmentOutcome,
  CategoryOutcome,
  EngineAssessment,
  EngineCategory,
  FailReason,
  MarkInput,
  OverallPolicy,
  OverallResult,
  PeriodOutcome,
  SubjectGradingConfig,
  SubjectOutcomeForOverall,
  SubjectResult,
} from "./types";

interface MarkPair {
  original?: MarkInput;
  retake?: MarkInput;
}

function indexMarks(marks: readonly MarkInput[]): Map<string, MarkPair> {
  const byAssessment = new Map<string, MarkPair>();
  for (const mark of marks) {
    const pair = byAssessment.get(mark.assessmentId) ?? {};
    if (mark.attempt === 2) pair.retake = mark;
    else pair.original = mark;
    byAssessment.set(mark.assessmentId, pair);
  }
  return byAssessment;
}

function percentOf(mark: MarkInput, assessment: EngineAssessment): number {
  return ((mark.score ?? 0) / assessment.maxMarks) * 100;
}

/**
 * How one assessment counts, after the school's missing-mark, absence and retake policies.
 *
 *  - No mark yet: an optional assessment is left out; a mandatory one is `missing` (the result
 *    stays incomplete) unless the school's policy says a missing mark is a zero.
 *  - Excused / not applicable: left out, and its weight goes to the other assessments.
 *  - Absent: a zero or `missing`, per the absence policy.
 *  - A graded retake replaces, beats, or (capped) partly replaces the original percentage.
 */
export function resolveAssessment(
  assessment: EngineAssessment,
  pair: MarkPair | undefined,
  config: SubjectGradingConfig,
): AssessmentOutcome {
  const base = {
    assessmentId: assessment.id,
    name: assessment.name,
    maxMarks: assessment.maxMarks,
  };
  const counted = (
    percentage: number,
    usedRetake: boolean,
    state: "counted" | "defaulted_zero",
  ) => ({
    ...base,
    state,
    percentage,
    points: (percentage / 100) * assessment.maxMarks,
    usedRetake,
  });
  const notCounted = (state: "excluded" | "missing") => ({
    ...base,
    state,
    percentage: null,
    points: null,
    usedRetake: false,
  });

  const original = pair?.original;
  const retake =
    config.retakePolicy !== "none" && pair?.retake?.status === "graded" ? pair.retake : undefined;

  let originalPercentage: number | null;
  let defaulted = false;
  if (!original) {
    if (retake) return counted(percentOf(retake, assessment), true, "counted");
    if (!assessment.mandatory) return notCounted("excluded");
    if (config.missingPolicy === "zero") return counted(0, false, "defaulted_zero");
    return notCounted("missing");
  }
  switch (original.status) {
    case "excused":
    case "not_applicable":
      return notCounted("excluded");
    case "absent":
      if (config.absentPolicy === "zero" || retake) {
        originalPercentage = 0;
        defaulted = true;
      } else {
        return notCounted("missing");
      }
      break;
    case "graded":
      originalPercentage = percentOf(original, assessment);
      break;
  }

  if (!retake) {
    return counted(originalPercentage, false, defaulted ? "defaulted_zero" : "counted");
  }

  const retakePercentage = percentOf(retake, assessment);
  let effective: number;
  switch (config.retakePolicy) {
    case "replace":
      effective = retakePercentage;
      break;
    case "highest":
      effective = Math.max(originalPercentage, retakePercentage);
      break;
    case "capped":
      effective = Math.max(
        originalPercentage,
        Math.min(retakePercentage, config.retakeCapPercentage ?? 100),
      );
      break;
    default:
      effective = originalPercentage;
  }
  return counted(effective, effective !== originalPercentage, "counted");
}

/** One category's percentage for one period (a term, or `null` for an annual-scope category). */
export function calculateCategory(
  category: EngineCategory,
  termId: string | null,
  config: SubjectGradingConfig,
  marks: Map<string, MarkPair>,
): CategoryOutcome {
  const items = config.assessments.filter(
    (assessment) => assessment.categoryId === category.id && assessment.termId === termId,
  );
  const outcomes = items.map((assessment) =>
    resolveAssessment(assessment, marks.get(assessment.id), config),
  );

  const counted = outcomes.filter(
    (outcome) => outcome.state === "counted" || outcome.state === "defaulted_zero",
  );
  if (category.dropLowest > 0 && counted.length > category.dropLowest) {
    const dropped = [...counted]
      .sort((a, b) => a.percentage! - b.percentage! || a.assessmentId.localeCompare(b.assessmentId))
      .slice(0, category.dropLowest);
    for (const outcome of dropped) outcome.state = "dropped";
  }

  const used = outcomes.filter(
    (outcome) => outcome.state === "counted" || outcome.state === "defaulted_zero",
  );
  const missing = outcomes.some((outcome) => outcome.state === "missing");

  let percentage: number | null = null;
  if (used.length > 0) {
    if (category.aggregation === "total_points") {
      const points = used.reduce((total, outcome) => total + outcome.points!, 0);
      const max = used.reduce((total, outcome) => total + outcome.maxMarks, 0);
      percentage = (points / max) * 100;
    } else {
      const weightOf = (outcome: AssessmentOutcome) =>
        items.find((assessment) => assessment.id === outcome.assessmentId)!.weight;
      const weighted = used.reduce(
        (total, outcome) => total + outcome.percentage! * weightOf(outcome),
        0,
      );
      const weights = used.reduce((total, outcome) => total + weightOf(outcome), 0);
      percentage = weighted / weights;
    }
  }

  return {
    categoryId: category.id,
    name: category.name,
    kind: category.kind,
    scope: category.scope,
    termId,
    weight: category.weight,
    percentage,
    empty: used.length === 0 && !missing,
    incomplete: missing,
    assessments: outcomes,
  };
}

/**
 * Weighted mean of components that have something to show. A component with no gradeable work
 * (everything excused) drops out and its weight is spread over the rest; a component that is
 * merely incomplete still contributes its partial percentage to the provisional figure.
 */
function weightedMean(components: { percentage: number | null; weight: number }[]): number | null {
  const usable = components.filter(
    (component) => component.percentage !== null && component.weight > 0,
  );
  const weights = usable.reduce((total, component) => total + component.weight, 0);
  if (weights === 0) return null;
  return (
    usable.reduce((total, component) => total + component.percentage! * component.weight, 0) /
    weights
  );
}

function pointsPercentage(categories: readonly CategoryOutcome[]): number | null {
  let points = 0;
  let max = 0;
  for (const category of categories) {
    for (const outcome of category.assessments) {
      if (outcome.state === "counted" || outcome.state === "defaulted_zero") {
        points += outcome.points!;
        max += outcome.maxMarks;
      }
    }
  }
  return max === 0 ? null : (points / max) * 100;
}

function calculatePeriod(
  termId: string,
  config: SubjectGradingConfig,
  marks: Map<string, MarkPair>,
): PeriodOutcome {
  const categories = config.categories
    .filter((category) => category.scope === "term")
    .map((category) => calculateCategory(category, termId, config, marks));
  const provisional =
    config.method === "total_points"
      ? pointsPercentage(categories)
      : weightedMean(
          categories.map((category) => ({
            percentage: category.percentage,
            weight: category.weight ?? 0,
          })),
        );
  const incomplete = categories.some((category) => category.incomplete);
  return {
    termId,
    provisionalPercentage: provisional,
    percentage: incomplete || provisional === null ? null : roundTo(provisional, config.rounding),
    incomplete,
    categories,
  };
}

/**
 * A subject's grade for one term (`options.termId`) or for the whole year (the default).
 *
 * Weighted method:
 *   category % = weighted mean (or points share) of its assessment percentages
 *   term %     = sum(category % x category weight) / sum(weights of categories with work)
 *   annual %   = sum(term % x term weight + annual category % x its weight) / sum(weights used)
 * Total-points method:
 *   % = sum(points earned) / sum(maximum points) over every counted assessment in scope
 *
 * The rounded percentage, marks and pass/fail exist only when the result is complete. A preview of
 * an incomplete result is `provisionalPercentage`, never `percentage`.
 */
export function calculateSubjectResult(
  config: SubjectGradingConfig,
  marks: readonly MarkInput[],
  options: { termId?: string | null } = {},
): SubjectResult {
  const indexed = indexMarks(marks);
  const termId = options.termId ?? null;

  let provisional: number | null;
  let terms: PeriodOutcome[];
  let annualCategories: CategoryOutcome[] = [];

  if (termId !== null) {
    const period = calculatePeriod(termId, config, indexed);
    terms = [period];
    provisional = period.provisionalPercentage;
  } else {
    const countedTerms =
      config.method === "total_points"
        ? config.terms
        : config.terms.filter((term) => term.weight > 0);
    terms = [...countedTerms]
      .sort((a, b) => a.sequence - b.sequence)
      .map((term) => calculatePeriod(term.termId, config, indexed));
    annualCategories = config.categories
      .filter((category) => category.scope === "annual")
      .map((category) => calculateCategory(category, null, config, indexed));
    if (config.method === "total_points") {
      provisional = pointsPercentage([
        ...terms.flatMap((term) => term.categories),
        ...annualCategories,
      ]);
    } else {
      provisional = weightedMean([
        ...terms.map((period) => ({
          percentage: period.provisionalPercentage,
          weight: config.terms.find((term) => term.termId === period.termId)!.weight,
        })),
        ...annualCategories.map((category) => ({
          percentage: category.percentage,
          weight: category.weight ?? 0,
        })),
      ]);
    }
  }

  const allCategories = [...terms.flatMap((term) => term.categories), ...annualCategories];
  const missingAssessments = allCategories.flatMap((category) =>
    category.assessments
      .filter((outcome) => outcome.state === "missing")
      .map((outcome) => ({ assessmentId: outcome.assessmentId, name: outcome.name })),
  );
  const incomplete = missingAssessments.length > 0 || provisional === null;

  if (incomplete) {
    return {
      status: "incomplete",
      termId,
      percentage: null,
      provisionalPercentage: provisional,
      marksObtained: null,
      maxMarks: config.maxMarks,
      gradeLabel: null,
      gpaPoints: null,
      passed: null,
      failReasons: [],
      missingAssessments,
      terms,
      annualCategories,
    };
  }

  const percentage = roundTo(provisional!, config.rounding);
  const marksObtained = roundTo((provisional! * config.maxMarks) / 100, config.rounding);
  const band = matchBand(percentage, config.scale);

  const failReasons: FailReason[] = [];
  if (!atLeast(percentage, config.passPercentage)) {
    failReasons.push({
      code: "BELOW_PASS_PERCENTAGE",
      required: config.passPercentage,
      actual: percentage,
    });
  }
  if (config.finalExamPassPercentage !== null) {
    for (const category of allCategories) {
      if (category.kind !== "final_exam" || category.empty) continue;
      const actual =
        category.percentage === null ? null : roundTo(category.percentage, config.rounding);
      if (actual === null || !atLeast(actual, config.finalExamPassPercentage)) {
        failReasons.push({
          code: "FINAL_EXAM_BELOW_REQUIRED",
          categoryId: category.categoryId,
          required: config.finalExamPassPercentage,
          actual,
        });
      }
    }
  }

  return {
    status: "complete",
    termId,
    percentage,
    provisionalPercentage: provisional,
    marksObtained,
    maxMarks: config.maxMarks,
    gradeLabel: band?.label ?? null,
    gpaPoints: band?.gpaPoints ?? null,
    passed: failReasons.length === 0,
    failReasons,
    missingAssessments,
    terms,
    annualCategories,
  };
}

/**
 * A student's overall result across their subjects.
 *
 *  - average = sum(subject % x coefficient) / sum(coefficients), over subjects counted in the
 *    average (exempt subjects are left out). Any counted subject still incomplete makes the
 *    overall result incomplete: no average is invented from the subjects that happen to be done.
 *  - totals add each counted subject's marks obtained and maximum marks.
 *  - failures count mandatory and (chosen) elective subjects; an optional subject's result is
 *    reported but never holds a student back.
 *  - status: promoted with no failures, supplementary with up to the policy's allowance,
 *    retained beyond it.
 */
export function calculateOverallResult(
  subjects: readonly SubjectOutcomeForOverall[],
  policy: OverallPolicy,
): OverallResult {
  const considered = subjects.filter((subject) => !subject.exempt);
  const counted = considered.filter((subject) => subject.includeInAverage);
  const incompleteSubjectIds = considered
    .filter((subject) => subject.requirement !== "optional" || subject.includeInAverage)
    .filter((subject) => subject.result === null || subject.result.status !== "complete")
    .map((subject) => subject.subjectId);

  const failedSubjectIds = considered
    .filter((subject) => subject.requirement !== "optional")
    .filter((subject) => subject.result?.passed === false)
    .map((subject) => subject.subjectId);

  if (incompleteSubjectIds.length > 0) {
    return {
      status: "incomplete",
      averagePercentage: null,
      totalObtained: null,
      totalMax: null,
      gradeLabel: null,
      subjectsFailed: failedSubjectIds.length,
      failedSubjectIds,
      incompleteSubjectIds,
      academicStatus: "incomplete",
    };
  }

  const coefficients = counted.reduce((total, subject) => total + subject.averageWeight, 0);
  const average =
    coefficients === 0
      ? null
      : roundTo(
          counted.reduce(
            (total, subject) => total + subject.result!.percentage! * subject.averageWeight,
            0,
          ) / coefficients,
          policy.rounding,
        );
  const totalObtained =
    counted.length === 0
      ? null
      : roundTo(
          counted.reduce((total, subject) => total + subject.result!.marksObtained!, 0),
          policy.rounding,
        );
  const totalMax =
    counted.length === 0
      ? null
      : counted.reduce((total, subject) => total + subject.result!.maxMarks, 0);
  const band = average !== null && policy.scale ? matchBand(average, policy.scale) : null;

  const failed = failedSubjectIds.length;
  return {
    status: "complete",
    averagePercentage: average,
    totalObtained,
    totalMax,
    gradeLabel: band?.label ?? null,
    subjectsFailed: failed,
    failedSubjectIds,
    incompleteSubjectIds,
    academicStatus:
      failed === 0
        ? "promoted"
        : failed <= policy.maxFailedSubjectsForSupplementary
          ? "supplementary"
          : "retained",
  };
}
