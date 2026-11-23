/**
 * Graduation requirements: whether a student meets a school's diploma rules (American high school
 * credits, a minimum GPA, required subjects, a national or admissions exam).
 *
 * A school groups its rules into a requirement set (db/migrations/000258). A student is checked
 * against a set using the same rows an academic transcript reads -- every academic year's current,
 * finalized annual result -- and their recorded external exam results. Everything here is pure: the
 * API loads those rows, and the checklist, the "not on track" report and the transcript line all
 * come from {@link evaluateGraduationRequirements}.
 *
 * Each rule is:
 *  - `met` when the finalized results already satisfy it;
 *  - `pending` when they do not yet, but the student's current year is not finalized, so results
 *    still to come can change the answer (a cumulative GPA or average stays pending until then,
 *    even when it is above the minimum now: the current year can still lower it);
 *  - `not_met` otherwise, with how far the student is from it (2 of 4 English credits).
 *
 * A set is met when every rule is met, not met when any rule is not met, and pending otherwise.
 */

import { calculateCumulativeResult, creditTotals } from "./cumulative";
import { EPSILON } from "./rounding";

import type { CumulativeSubjectInput, CumulativeYearInput } from "./cumulative";
import type { RoundingRule, ValidationIssue } from "./types";

export const GRADUATION_RULE_TYPES = [
  "total_credits",
  "group_credits",
  "subjects_passed",
  "cumulative_gpa",
  "cumulative_average",
  "external_exam",
] as const;

export type GraduationRuleType = (typeof GRADUATION_RULE_TYPES)[number];

export type GraduationStatus = "met" | "not_met" | "pending";

/** Limits shared by the API's request validation and the web form. */
export const GRADUATION_LIMITS = {
  setNameMaxLength: 120,
  groupNameMaxLength: 120,
  maxRulesPerSet: 50,
  maxSubjectsPerRule: 100,
  maxCredits: 1000,
  maxAverage: 100,
  maxGpa: 10,
  maxExamTotal: 100000,
} as const;

export interface GraduationRuleDefinition {
  /** Echoed back on the evaluation, to match it to the stored rule. */
  id: string;
  type: GraduationRuleType;
  /**
   * The threshold: credits for the credit rules, the GPA or the average percentage for the
   * cumulative rules, the exam's minimum total (null: recorded at all) for an external exam.
   * Unused (null) for `subjects_passed`.
   */
  minValue: number | null;
  /** The named group of subjects ("English", "Core sciences") for the group and subject rules. */
  groupName: string | null;
  /** The group's subjects; empty for the other rule types. */
  subjectIds: readonly string[];
  /** The external exam (`external_exam` rules only). */
  externalExamId: string | null;
}

/** A finalized subject result, as the transcript's cumulative figures read it. */
export interface GraduationSubjectInput extends CumulativeSubjectInput {
  subjectId: string;
}

export interface GraduationYearInput extends CumulativeYearInput {
  subjects: readonly GraduationSubjectInput[];
}

export interface GraduationExamResultInput {
  examId: string;
  /** The exam's computed total; null when the exam has no total or a component was not scored. */
  totalScore: number | null;
}

export interface GraduationEvaluationInput {
  rules: readonly GraduationRuleDefinition[];
  /** Every academic year's current, finalized annual result, oldest first. */
  years: readonly GraduationYearInput[];
  examResults: readonly GraduationExamResultInput[];
  /** The student is in a year that has no finalized annual result yet. */
  currentYearPending: boolean;
  /** How the cumulative average is rounded (the latest year's rule, as on transcripts). */
  rounding: RoundingRule;
}

export interface GraduationRuleEvaluation {
  ruleId: string;
  type: GraduationRuleType;
  status: GraduationStatus;
  /**
   * Where the student stands: credits earned, subjects passed, the cumulative GPA or average, or
   * the best total recorded for the exam (null when there is none, or it cannot be worked out).
   */
  current: number | null;
  /** What the rule asks for: credits, the number of subjects, the GPA, average or total. */
  required: number | null;
  /** `subjects_passed`: the group's subjects not passed yet. Empty for other rules. */
  missingSubjectIds: string[];
}

export interface GraduationEvaluation {
  status: GraduationStatus;
  rules: GraduationRuleEvaluation[];
  rulesMet: number;
  rulesTotal: number;
}

/** Credits carry two decimals; comparisons allow for floating point noise. */
const reached = (current: number | null, required: number): boolean =>
  current !== null && current >= required - EPSILON;

function unmet(pending: boolean): GraduationStatus {
  return pending ? "pending" : "not_met";
}

function evaluateRule(
  rule: GraduationRuleDefinition,
  input: GraduationEvaluationInput,
  subjects: readonly GraduationSubjectInput[],
  cumulative: ReturnType<typeof calculateCumulativeResult>,
): GraduationRuleEvaluation {
  const base = { ruleId: rule.id, type: rule.type, missingSubjectIds: [] as string[] };
  const pending = input.currentYearPending;
  switch (rule.type) {
    case "total_credits":
    case "group_credits": {
      const group = new Set(rule.subjectIds);
      const counted =
        rule.type === "total_credits"
          ? subjects
          : subjects.filter((subject) => group.has(subject.subjectId));
      const current = creditTotals(counted).creditsEarned ?? 0;
      const required = rule.minValue ?? 0;
      return {
        ...base,
        status: reached(current, required) ? "met" : unmet(pending),
        current,
        required,
      };
    }
    case "subjects_passed": {
      const passed = new Set(
        subjects
          .filter((subject) => subject.status !== "exempt" && subject.passed === true)
          .map((subject) => subject.subjectId),
      );
      const required = [...new Set(rule.subjectIds)];
      const missing = required.filter((subjectId) => !passed.has(subjectId));
      return {
        ...base,
        status: missing.length === 0 ? "met" : unmet(pending),
        current: required.length - missing.length,
        required: required.length,
        missingSubjectIds: missing,
      };
    }
    case "cumulative_gpa":
    case "cumulative_average": {
      const current =
        rule.type === "cumulative_gpa" ? cumulative.gpa : cumulative.averagePercentage;
      const required = rule.minValue ?? 0;
      // Not monotonic: the year still to be finalized can lower it, so it waits for that year.
      const status: GraduationStatus = pending
        ? "pending"
        : reached(current, required)
          ? "met"
          : "not_met";
      return { ...base, status, current, required };
    }
    case "external_exam": {
      const results = input.examResults.filter((result) => result.examId === rule.externalExamId);
      const totals = results
        .map((result) => result.totalScore)
        .filter((total): total is number => total !== null);
      const best = totals.length === 0 ? null : Math.max(...totals);
      const met = rule.minValue === null ? results.length > 0 : reached(best, rule.minValue);
      return {
        ...base,
        status: met ? "met" : unmet(pending),
        current: best,
        required: rule.minValue,
      };
    }
  }
}

/** Check a student against a requirement set's rules (see the module comment for the rules). */
export function evaluateGraduationRequirements(
  input: GraduationEvaluationInput,
): GraduationEvaluation {
  const subjects = input.years.flatMap((year) => year.subjects);
  const cumulative = calculateCumulativeResult(input.years, input.rounding);
  const rules = input.rules.map((rule) => evaluateRule(rule, input, subjects, cumulative));
  const rulesMet = rules.filter((rule) => rule.status === "met").length;
  const status: GraduationStatus = rules.some((rule) => rule.status === "not_met")
    ? "not_met"
    : rulesMet === rules.length
      ? "met"
      : "pending";
  return { status, rules, rulesMet, rulesTotal: rules.length };
}

/**
 * Check one rule's definition. Errors name what is wrong; the API refuses a rule with any, and the
 * web form shows the same messages as the user types.
 */
export function validateGraduationRule(
  rule: Omit<GraduationRuleDefinition, "id">,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string) =>
    issues.push({ code, severity: "error", message });
  const needsGroup = rule.type === "group_credits" || rule.type === "subjects_passed";
  const groupName = rule.groupName?.trim() ?? "";

  if (needsGroup) {
    if (groupName === "") error("GRADUATION_GROUP_NAME_REQUIRED", "Name the group of subjects.");
    if (groupName.length > GRADUATION_LIMITS.groupNameMaxLength) {
      error(
        "GRADUATION_GROUP_NAME_TOO_LONG",
        `A group name is at most ${GRADUATION_LIMITS.groupNameMaxLength} characters.`,
      );
    }
    if (rule.subjectIds.length === 0) {
      error("GRADUATION_SUBJECTS_REQUIRED", "Choose at least one subject for the group.");
    }
    if (rule.subjectIds.length > GRADUATION_LIMITS.maxSubjectsPerRule) {
      error(
        "GRADUATION_TOO_MANY_SUBJECTS",
        `A group has at most ${GRADUATION_LIMITS.maxSubjectsPerRule} subjects.`,
      );
    }
    if (new Set(rule.subjectIds).size !== rule.subjectIds.length) {
      error("GRADUATION_DUPLICATE_SUBJECT", "A subject is listed twice in the group.");
    }
  } else {
    if (rule.groupName !== null) {
      error("GRADUATION_GROUP_NOT_ALLOWED", "Only subject group rules have a group name.");
    }
    if (rule.subjectIds.length > 0) {
      error("GRADUATION_SUBJECTS_NOT_ALLOWED", "Only subject group rules list subjects.");
    }
  }

  if (rule.type === "external_exam") {
    if (rule.externalExamId === null) {
      error("GRADUATION_EXAM_REQUIRED", "Choose the external exam.");
    }
  } else if (rule.externalExamId !== null) {
    error("GRADUATION_EXAM_NOT_ALLOWED", "Only external exam rules name an exam.");
  }

  const max: Record<GraduationRuleType, number | null> = {
    total_credits: GRADUATION_LIMITS.maxCredits,
    group_credits: GRADUATION_LIMITS.maxCredits,
    subjects_passed: null,
    cumulative_gpa: GRADUATION_LIMITS.maxGpa,
    cumulative_average: GRADUATION_LIMITS.maxAverage,
    external_exam: GRADUATION_LIMITS.maxExamTotal,
  };
  const limit = max[rule.type];
  if (limit === null) {
    if (rule.minValue !== null) {
      error("GRADUATION_MIN_NOT_ALLOWED", "A passed-subjects rule has no minimum value.");
    }
  } else if (rule.minValue === null) {
    if (rule.type !== "external_exam") {
      error("GRADUATION_MIN_REQUIRED", "Enter the minimum value.");
    }
  } else if (!Number.isFinite(rule.minValue) || rule.minValue <= 0 || rule.minValue > limit) {
    error("GRADUATION_MIN_OUT_OF_RANGE", `The minimum must be above 0 and at most ${limit}.`);
  } else if (Math.abs(Math.round(rule.minValue * 100) - rule.minValue * 100) > EPSILON) {
    // Stored as numeric(8,2): more decimals would be silently rounded.
    error("GRADUATION_MIN_PRECISION", "The minimum has at most two decimals.");
  }
  return issues;
}
