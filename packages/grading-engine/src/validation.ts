import { validateGradeScale, WEIGHT_TOLERANCE } from "./rounding";

import type { SubjectGradingConfig, ValidationIssue, WeightSummary } from "./types";

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const isHundred = (value: number): boolean => Math.abs(value - 100) <= WEIGHT_TOLERANCE;

/**
 * The two weight totals a weighted configuration must satisfy.
 *
 *  - `term`-scope categories build each term grade, so their weights total 100 (when any exist).
 *  - The annual grade is built from the weighted terms plus the `annual`-scope categories, so the
 *    term weights and annual category weights together total 100.
 *
 * Total-points configurations carry no weights and are always reported valid here.
 */
export function summarizeWeights(config: SubjectGradingConfig): WeightSummary {
  if (config.method === "total_points") {
    return { termCategoryTotal: 0, annualTotal: 0, valid: true };
  }
  const termCategories = config.categories.filter((category) => category.scope === "term");
  const annualCategories = config.categories.filter((category) => category.scope === "annual");
  const termCategoryTotal = sum(termCategories.map((category) => category.weight ?? 0));
  const annualTotal =
    sum(config.terms.map((term) => term.weight)) +
    sum(annualCategories.map((category) => category.weight ?? 0));
  const valid =
    (termCategories.length === 0 || isHundred(termCategoryTotal)) && isHundred(annualTotal);
  return { termCategoryTotal, annualTotal, valid };
}

/**
 * Everything that would make the configuration compute something other than what the school
 * intends. `error` issues block publication (and any save while the year is active); `warning`
 * issues are shown but allowed.
 */
export function validateSubjectConfig(config: SubjectGradingConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string, ref?: string) =>
    issues.push({ code, severity: "error", message, ref });
  const warning = (code: string, message: string, ref?: string) =>
    issues.push({ code, severity: "warning", message, ref });

  if (!(config.maxMarks > 0)) error("MAX_MARKS_INVALID", "Maximum marks must be greater than 0.");
  if (!(config.passPercentage >= 0 && config.passPercentage <= 100)) {
    error("PASS_PERCENTAGE_INVALID", "The passing percentage must be between 0 and 100.");
  }
  if (
    config.finalExamPassPercentage !== null &&
    !(config.finalExamPassPercentage >= 0 && config.finalExamPassPercentage <= 100)
  ) {
    error(
      "FINAL_EXAM_PASS_PERCENTAGE_INVALID",
      "The final exam passing percentage must be between 0 and 100.",
    );
  }
  if (!(
    Number.isInteger(config.rounding.decimals) &&
    config.rounding.decimals >= 0 &&
    config.rounding.decimals <= 4
  )) {
    error("ROUNDING_DECIMALS_INVALID", "Rounding must keep between 0 and 4 decimal places.");
  }
  if (config.retakePolicy === "capped") {
    if (
      config.retakeCapPercentage === null ||
      !(config.retakeCapPercentage > 0 && config.retakeCapPercentage <= 100)
    ) {
      error("RETAKE_CAP_REQUIRED", "A capped retake policy needs a cap between 0 and 100 percent.");
    }
  }

  // No scale means the subject is reported numerically only (no letter grade); a scale that is
  // present must be coherent.
  if (config.scale.length > 0) issues.push(...validateGradeScale(config.scale));

  if (config.categories.length === 0) {
    error("NO_CATEGORIES", "Add at least one assessment category.");
  }

  const categoryIds = new Set(config.categories.map((category) => category.id));
  const termIds = new Set(config.terms.map((term) => term.termId));
  const categoryNames = new Set<string>();
  for (const category of config.categories) {
    const key = category.name.trim().toLowerCase();
    if (categoryNames.has(key)) {
      error("DUPLICATE_CATEGORY_NAME", `Two categories are named "${category.name}".`, category.id);
    }
    categoryNames.add(key);
    if (!(Number.isInteger(category.dropLowest) && category.dropLowest >= 0)) {
      error(
        "DROP_LOWEST_INVALID",
        `"${category.name}" drops a negative number of marks.`,
        category.id,
      );
    }
  }

  for (const term of config.terms) {
    if (!(term.weight >= 0 && term.weight <= 100)) {
      error(
        "TERM_WEIGHT_INVALID",
        `The weight of ${term.name} must be between 0 and 100.`,
        term.termId,
      );
    }
  }

  // --- Weights ---------------------------------------------------------------------------------
  if (config.method === "weighted") {
    for (const category of config.categories) {
      if (category.weight === null || !(category.weight > 0 && category.weight <= 100)) {
        error(
          "CATEGORY_WEIGHT_REQUIRED",
          `"${category.name}" needs a weight between 0 and 100 percent.`,
          category.id,
        );
      }
    }
    const termCategories = config.categories.filter((category) => category.scope === "term");
    const summary = summarizeWeights(config);
    if (termCategories.length > 0 && !isHundred(summary.termCategoryTotal)) {
      error(
        "TERM_CATEGORY_WEIGHT_TOTAL",
        `Term category weights total ${round3(summary.termCategoryTotal)}%; they must total 100%.`,
      );
    }
    if (!isHundred(summary.annualTotal)) {
      error(
        "ANNUAL_WEIGHT_TOTAL",
        `Term weights plus annual category weights total ${round3(summary.annualTotal)}%; they must total 100%.`,
      );
    }
    const weightedTerms = config.terms.filter((term) => term.weight > 0);
    if (termCategories.length > 0 && weightedTerms.length === 0) {
      error(
        "TERM_WEIGHT_MISSING",
        "Term categories are configured but no term carries any weight in the annual grade.",
      );
    }
    if (termCategories.length === 0 && weightedTerms.length > 0) {
      error(
        "TERM_WEIGHT_WITHOUT_TERM_CATEGORIES",
        "Terms carry annual weight but there are no term categories to build a term grade from.",
      );
    }
  } else {
    if (config.categories.some((category) => category.weight !== null && category.weight !== 0)) {
      warning(
        "WEIGHT_IGNORED_FOR_TOTAL_POINTS",
        "Category weights are ignored when the subject is graded by total points.",
      );
    }
  }

  // --- Assessments -----------------------------------------------------------------------------
  const perCategoryTerm = new Map<string, number>();
  const names = new Set<string>();
  for (const assessment of config.assessments) {
    if (!categoryIds.has(assessment.categoryId)) {
      error(
        "ASSESSMENT_CATEGORY_UNKNOWN",
        `"${assessment.name}" belongs to a category that is not part of this subject.`,
        assessment.id,
      );
      continue;
    }
    const category = config.categories.find((candidate) => candidate.id === assessment.categoryId)!;
    if (!(assessment.maxMarks > 0)) {
      error(
        "ASSESSMENT_MAX_MARKS_INVALID",
        `"${assessment.name}" needs maximum marks above 0.`,
        assessment.id,
      );
    }
    if (!(assessment.weight > 0)) {
      error(
        "ASSESSMENT_WEIGHT_INVALID",
        `"${assessment.name}" needs a weight above 0.`,
        assessment.id,
      );
    }
    if (category.scope === "term" && assessment.termId === null) {
      error(
        "ASSESSMENT_SCOPE_MISMATCH",
        `"${assessment.name}" is in the term category "${category.name}" but has no term.`,
        assessment.id,
      );
    }
    if (category.scope === "annual" && assessment.termId !== null) {
      error(
        "ASSESSMENT_SCOPE_MISMATCH",
        `"${assessment.name}" is in the annual category "${category.name}" and cannot belong to a term.`,
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
    if (
      config.method === "weighted" &&
      category.scope === "term" &&
      assessment.termId !== null &&
      (config.terms.find((term) => term.termId === assessment.termId)?.weight ?? 0) === 0
    ) {
      error(
        "ASSESSMENT_TERM_NOT_WEIGHTED",
        `"${assessment.name}" is in a term that carries no weight, so it would never count.`,
        assessment.id,
      );
    }
    const key = `${assessment.categoryId}|${assessment.termId ?? "annual"}`;
    perCategoryTerm.set(key, (perCategoryTerm.get(key) ?? 0) + 1);
    const nameKey = `${key}|${assessment.name.trim().toLowerCase()}`;
    if (names.has(nameKey)) {
      warning(
        "DUPLICATE_ASSESSMENT_NAME",
        `"${assessment.name}" appears twice in the same category and term.`,
        assessment.id,
      );
    }
    names.add(nameKey);
  }

  // Every weighted category needs assessments wherever it is graded, or its weight means nothing.
  for (const category of config.categories) {
    const periods =
      category.scope === "annual"
        ? [null]
        : config.terms
            .filter((term) => config.method === "total_points" || term.weight > 0)
            .map((term) => term.termId);
    for (const termId of periods) {
      const count = perCategoryTerm.get(`${category.id}|${termId ?? "annual"}`) ?? 0;
      const where =
        termId === null ? "" : ` in ${config.terms.find((term) => term.termId === termId)?.name}`;
      if (count === 0) {
        error(
          "CATEGORY_WITHOUT_ASSESSMENTS",
          `"${category.name}" has no assessments${where}.`,
          category.id,
        );
      } else if (category.dropLowest >= count) {
        error(
          "DROP_LOWEST_TOO_LARGE",
          `"${category.name}" drops ${category.dropLowest} marks but has only ${count}${where}.`,
          category.id,
        );
      }
    }
  }

  if (
    config.finalExamPassPercentage !== null &&
    !config.categories.some((category) => category.kind === "final_exam")
  ) {
    error(
      "FINAL_EXAM_RULE_WITHOUT_FINAL",
      "The final exam must be passed on its own, but no category is marked as the final exam.",
    );
  }

  return issues;
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
