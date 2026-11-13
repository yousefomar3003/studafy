import { EPSILON, roundTo } from "./rounding";

import type {
  AssessmentOutcome,
  CategoryOutcome,
  EngineAssessment,
  EngineCategory,
  EngineDescriptor,
  FailReason,
  MarkInput,
  PeriodOutcome,
  SubjectGradingConfig,
  SubjectResult,
  ValidationIssue,
} from "./types";

/**
 * Descriptive grading (kindergarten and early primary): no marks, only descriptors.
 *
 * A descriptive subject's categories group its skills ("Reading", "Numbers") and its assessments
 * are the skills themselves ("Reads fluently", "Counts to 20"), each in a term. A teacher records a
 * descriptor from the grade's scale for every skill and student. Nothing here is a percentage:
 *
 *  - the subject never has a percentage, marks or GPA, and never counts in the numeric average;
 *  - when every descriptor carries points, the subject's own descriptor is the one nearest the
 *    (assessment-weighted) average points of the counted skills, ties going to the higher one;
 *  - without points, only the skills' descriptors are reported and the subject is passed;
 *  - a subject whose descriptor is marked "not achieved" is not passed.
 *
 * Missing, absent and excused skills follow the same school policies as numeric marks, with the
 * lowest descriptor standing in for a zero. Retakes do not apply.
 */

interface MarkPair {
  original?: MarkInput;
  retake?: MarkInput;
}

export function descriptorsWithPoints(descriptors: readonly EngineDescriptor[]): boolean {
  return descriptors.length > 0 && descriptors.every((descriptor) => descriptor.points !== null);
}

/** The descriptor nearest `points`; on a tie the higher one (the scale is ordered highest first). */
export function nearestDescriptor(
  points: number,
  descriptors: readonly EngineDescriptor[],
): EngineDescriptor | null {
  let best: EngineDescriptor | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const descriptor of descriptors) {
    if (descriptor.points === null) continue;
    const distance = Math.abs(descriptor.points - points);
    const higherOnTie =
      best !== null &&
      Math.abs(distance - bestDistance) <= EPSILON &&
      descriptor.points > (best.points ?? Number.NEGATIVE_INFINITY);
    if (distance < bestDistance - EPSILON || higherOnTie) {
      best = descriptor;
      bestDistance = distance;
    }
  }
  return best;
}

function resolveSkill(
  assessment: EngineAssessment,
  pair: MarkPair | undefined,
  config: SubjectGradingConfig,
): AssessmentOutcome {
  const descriptors = config.descriptors ?? [];
  const lowest = descriptors[descriptors.length - 1] ?? null;
  const base = {
    assessmentId: assessment.id,
    name: assessment.name,
    maxMarks: assessment.maxMarks,
    percentage: null,
    usedRetake: false,
  };
  const counted = (descriptor: EngineDescriptor, state: "counted" | "defaulted_zero") => ({
    ...base,
    state,
    points: descriptor.points,
    descriptorId: descriptor.id,
    descriptorLabel: descriptor.label,
  });
  const notCounted = (state: "excluded" | "missing") => ({
    ...base,
    state,
    points: null,
    descriptorId: null,
    descriptorLabel: null,
  });

  const original = pair?.original;
  if (!original) {
    if (!assessment.mandatory) return notCounted("excluded");
    if (config.missingPolicy === "zero" && lowest) return counted(lowest, "defaulted_zero");
    return notCounted("missing");
  }
  switch (original.status) {
    case "excused":
    case "not_applicable":
      return notCounted("excluded");
    case "absent":
      if (config.absentPolicy === "zero" && lowest) return counted(lowest, "defaulted_zero");
      return notCounted("missing");
    case "graded": {
      const chosen = descriptors.find((descriptor) => descriptor.id === original.descriptorId);
      return chosen ? counted(chosen, "counted") : notCounted("missing");
    }
  }
}

function skillCategory(
  category: EngineCategory,
  termId: string | null,
  config: SubjectGradingConfig,
  marks: Map<string, MarkPair>,
): CategoryOutcome {
  const outcomes = config.assessments
    .filter((assessment) => assessment.categoryId === category.id && assessment.termId === termId)
    .map((assessment) => resolveSkill(assessment, marks.get(assessment.id), config));
  const used = outcomes.filter(
    (outcome) => outcome.state === "counted" || outcome.state === "defaulted_zero",
  );
  const missing = outcomes.some((outcome) => outcome.state === "missing");
  return {
    categoryId: category.id,
    name: category.name,
    kind: category.kind,
    scope: category.scope,
    termId,
    weight: null,
    percentage: null,
    empty: used.length === 0 && !missing,
    incomplete: missing,
    assessments: outcomes,
  };
}

function skillPeriod(
  termId: string,
  config: SubjectGradingConfig,
  marks: Map<string, MarkPair>,
): PeriodOutcome {
  const categories = config.categories
    .filter((category) => category.scope === "term")
    .map((category) => skillCategory(category, termId, config, marks));
  return {
    termId,
    provisionalPercentage: null,
    percentage: null,
    incomplete: categories.some((category) => category.incomplete),
    categories,
  };
}

/** A descriptive subject's result for one term (`termId`) or the whole year (`null`). */
export function calculateDescriptiveResult(
  config: SubjectGradingConfig,
  marks: Map<string, MarkPair>,
  termId: string | null,
): SubjectResult {
  const terms =
    termId !== null
      ? [skillPeriod(termId, config, marks)]
      : [...config.terms]
          .sort((a, b) => a.sequence - b.sequence)
          .map((term) => skillPeriod(term.termId, config, marks));
  const annualCategories =
    termId !== null
      ? []
      : config.categories
          .filter((category) => category.scope === "annual")
          .map((category) => skillCategory(category, null, config, marks));

  const outcomes = [...terms.flatMap((term) => term.categories), ...annualCategories].flatMap(
    (category) => category.assessments,
  );
  const missingAssessments = outcomes
    .filter((outcome) => outcome.state === "missing")
    .map((outcome) => ({ assessmentId: outcome.assessmentId, name: outcome.name }));
  const used = outcomes.filter(
    (outcome) => outcome.state === "counted" || outcome.state === "defaulted_zero",
  );

  const common = {
    termId,
    percentage: null,
    provisionalPercentage: null,
    marksObtained: null,
    maxMarks: config.maxMarks,
    gpaPoints: null,
    missingAssessments,
    terms,
    annualCategories,
    descriptive: true,
  };

  if (missingAssessments.length > 0 || used.length === 0) {
    return {
      ...common,
      status: "incomplete",
      gradeLabel: null,
      passed: null,
      failReasons: [],
      descriptor: null,
    };
  }

  const descriptors = config.descriptors ?? [];
  let subjectDescriptor: SubjectResult["descriptor"] = null;
  let chosen: EngineDescriptor | null = null;
  if (descriptorsWithPoints(descriptors)) {
    const weightOf = (outcome: AssessmentOutcome) =>
      config.assessments.find((assessment) => assessment.id === outcome.assessmentId)?.weight ?? 1;
    const weights = used.reduce((total, outcome) => total + weightOf(outcome), 0);
    const average =
      used.reduce((total, outcome) => total + outcome.points! * weightOf(outcome), 0) / weights;
    chosen = nearestDescriptor(average, descriptors);
    if (chosen) {
      subjectDescriptor = {
        id: chosen.id,
        label: chosen.label,
        averagePoints: roundTo(average, config.rounding),
      };
    }
  }

  const failReasons: FailReason[] = chosen?.notAchieved
    ? [{ code: "DESCRIPTOR_NOT_ACHIEVED", descriptor: chosen.label }]
    : [];
  return {
    ...common,
    status: "complete",
    gradeLabel: chosen?.label ?? null,
    passed: failReasons.length === 0,
    failReasons,
    descriptor: subjectDescriptor,
  };
}

/** What would make a descriptive subject's setup report something other than intended. */
export function validateDescriptiveConfig(config: SubjectGradingConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string, ref?: string) =>
    issues.push({ code, severity: "error", message, ref });
  const warning = (code: string, message: string, ref?: string) =>
    issues.push({ code, severity: "warning", message, ref });

  const descriptors = config.descriptors ?? [];
  if (descriptors.length < 2) {
    error(
      "DESCRIPTORS_REQUIRED",
      "Set up this grade's descriptor scale (at least two descriptors, such as Excellent and Needs improvement).",
    );
  }
  const labels = new Set<string>();
  for (const descriptor of descriptors) {
    const key = descriptor.label.trim().toLowerCase();
    if (labels.has(key)) {
      error(
        "DUPLICATE_DESCRIPTOR",
        `Two descriptors are named "${descriptor.label}".`,
        descriptor.id,
      );
    }
    labels.add(key);
  }
  const withPoints = descriptors.filter((descriptor) => descriptor.points !== null).length;
  if (withPoints > 0 && withPoints < descriptors.length) {
    error(
      "DESCRIPTOR_POINTS_PARTIAL",
      "Give every descriptor points, or none: a subject descriptor is only worked out when all have points.",
    );
  }
  if (withPoints === 0 && descriptors.some((descriptor) => descriptor.notAchieved)) {
    warning(
      "DESCRIPTOR_NOT_ACHIEVED_UNUSED",
      'A descriptor is marked "not achieved", but without points no subject descriptor is worked out, so no student fails this subject.',
    );
  }

  if (config.categories.length === 0) {
    error("NO_CATEGORIES", "Add at least one skill group.");
  }
  if (config.assessments.length === 0) {
    error("NO_SKILLS", "Add at least one skill to assess.");
  }

  const categoryIds = new Set(config.categories.map((category) => category.id));
  const termIds = new Set(config.terms.map((term) => term.termId));
  const used = new Set<string>();
  const names = new Set<string>();
  for (const assessment of config.assessments) {
    if (!categoryIds.has(assessment.categoryId)) {
      error(
        "ASSESSMENT_CATEGORY_UNKNOWN",
        `"${assessment.name}" belongs to a skill group that is not part of this subject.`,
        assessment.id,
      );
      continue;
    }
    used.add(assessment.categoryId);
    const category = config.categories.find((candidate) => candidate.id === assessment.categoryId)!;
    if (category.scope === "term" && assessment.termId === null) {
      error(
        "ASSESSMENT_SCOPE_MISMATCH",
        `"${assessment.name}" is in the term group "${category.name}" but has no term.`,
        assessment.id,
      );
    }
    if (category.scope === "annual" && assessment.termId !== null) {
      error(
        "ASSESSMENT_SCOPE_MISMATCH",
        `"${assessment.name}" is in the annual group "${category.name}" and cannot belong to a term.`,
        assessment.id,
      );
    }
    if (assessment.termId !== null && !termIds.has(assessment.termId)) {
      error(
        "ASSESSMENT_TERM_UNKNOWN",
        `"${assessment.name}" belongs to a term outside this academic year's configured terms.`,
        assessment.id,
      );
    }
    const nameKey = `${assessment.categoryId}|${assessment.termId ?? "annual"}|${assessment.name
      .trim()
      .toLowerCase()}`;
    if (names.has(nameKey)) {
      warning(
        "DUPLICATE_ASSESSMENT_NAME",
        `"${assessment.name}" appears twice in the same group and term.`,
        assessment.id,
      );
    }
    names.add(nameKey);
  }
  for (const category of config.categories) {
    if (!used.has(category.id)) {
      warning("CATEGORY_WITHOUT_SKILLS", `"${category.name}" has no skills yet.`, category.id);
    }
  }
  return issues;
}
