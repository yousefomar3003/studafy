/**
 * Multi-year results: one result weighted across several school years -- "grade 11 counts 40%,
 * grade 12 60%" -- per subject and overall, as Jordan's two-year Tawjihi and several national
 * systems report it.
 *
 * A school keeps the weights per grade level (db/migrations/000266, `multi_year_result_configs`).
 * The API finds, for each listed grade level, the student's current finalized annual result in that
 * grade (a repeated grade: the later year) and hands it here. Everything is pure:
 *
 *  - each year is `finalized` (with the overall average percentage and each subject's percentage),
 *    `incomplete` (finalized, but the result is incomplete), `pending` (the student is in that grade
 *    now, or has not reached it yet) or `missing` (the student went through that grade without a
 *    finalized result here -- e.g. they joined the school later);
 *  - the result is `complete` only when every year is finalized; `incomplete` as soon as a year is
 *    missing or incomplete (it cannot be worked out); `pending` otherwise. Only a complete result
 *    carries the weighted figures; until then each year's own figures are shown;
 *  - overall = sum(weight x the year's overall average) / sum(weights). Weights are relative
 *    (40 and 60, or 2 and 3, are the same);
 *  - per subject, the same weighted mean over the years in which the subject has a percentage (a
 *    subject taught only in grade 12 is that year's figure), with the years it counted;
 *  - figures are rounded by the latest year's rounding rule (two decimals when none is known).
 */

import { roundTo } from "./rounding";

import type { RoundingRule, ValidationIssue } from "./types";

export type MultiYearYearStatus = "finalized" | "incomplete" | "pending" | "missing";
export type MultiYearStatus = "complete" | "pending" | "incomplete";

/** Limits shared by the API's request validation and the web form. */
export const MULTI_YEAR_LIMITS = {
  nameMaxLength: 120,
  minYears: 2,
  maxYears: 6,
  maxWeight: 100,
} as const;

export interface MultiYearSubjectInput {
  subjectId: string;
  /** The subject's final percentage that year; null when not complete, exempt or descriptive. */
  percentage: number | null;
}

export interface MultiYearYearInput {
  /** Echoed back: the grade level the year stands for. */
  key: string;
  weight: number;
  status: MultiYearYearStatus;
  /** The year's overall average percentage (finalized years only). */
  overallPercentage: number | null;
  subjects: readonly MultiYearSubjectInput[];
}

export interface MultiYearSubjectResult {
  subjectId: string;
  /** Weighted percentage; null until the result is complete. */
  percentage: number | null;
  /** The years (keys) whose figure counted, in the configured order. */
  yearsCounted: string[];
  /** Each year's percentage, in the configured order (null where it has none). */
  byYear: (number | null)[];
}

export interface MultiYearResult {
  status: MultiYearStatus;
  /** Weighted overall percentage; null until complete. */
  overallPercentage: number | null;
  /** Each year's share of the overall in percent (weights normalized), in the configured order. */
  shares: number[];
  subjects: MultiYearSubjectResult[];
}

const DEFAULT_ROUNDING: RoundingRule = { decimals: 2, mode: "half_up" };

export function calculateMultiYearResult(
  years: readonly MultiYearYearInput[],
  rounding: RoundingRule = DEFAULT_ROUNDING,
): MultiYearResult {
  const totalWeight = years.reduce((total, year) => total + year.weight, 0);
  const shares = years.map((year) =>
    totalWeight > 0 ? roundTo((year.weight / totalWeight) * 100, DEFAULT_ROUNDING) : 0,
  );
  const status: MultiYearStatus = years.some(
    (year) =>
      year.status === "missing" ||
      year.status === "incomplete" ||
      (year.status === "finalized" && year.overallPercentage === null),
  )
    ? "incomplete"
    : years.some((year) => year.status === "pending") || years.length === 0
      ? "pending"
      : "complete";

  const subjectIds: string[] = [];
  for (const year of years) {
    if (year.status !== "finalized") continue;
    for (const subject of year.subjects) {
      if (!subjectIds.includes(subject.subjectId)) subjectIds.push(subject.subjectId);
    }
  }
  const complete = status === "complete" && totalWeight > 0;
  const subjects = subjectIds.map((subjectId) => {
    const byYear = years.map((year) =>
      year.status === "finalized"
        ? (year.subjects.find((subject) => subject.subjectId === subjectId)?.percentage ?? null)
        : null,
    );
    let weight = 0;
    let sum = 0;
    const yearsCounted: string[] = [];
    years.forEach((year, index) => {
      const value = byYear.at(index);
      if (value === null || value === undefined) return;
      weight += year.weight;
      sum += year.weight * value;
      yearsCounted.push(year.key);
    });
    return {
      subjectId,
      percentage: complete && weight > 0 ? roundTo(sum / weight, rounding) : null,
      yearsCounted,
      byYear,
    };
  });

  return {
    status,
    overallPercentage: complete
      ? roundTo(
          years.reduce((total, year) => total + year.weight * year.overallPercentage!, 0) /
            totalWeight,
          rounding,
        )
      : null,
    shares,
    subjects,
  };
}

/** Check a configuration's years: 2-6 distinct grade levels, each with a weight. */
export function validateMultiYearYears(
  years: readonly { key: string; weight: number }[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string) =>
    issues.push({ code, severity: "error", message });
  if (years.length < MULTI_YEAR_LIMITS.minYears || years.length > MULTI_YEAR_LIMITS.maxYears) {
    error(
      "MULTI_YEAR_YEAR_COUNT",
      `Choose ${MULTI_YEAR_LIMITS.minYears} to ${MULTI_YEAR_LIMITS.maxYears} grade levels.`,
    );
  }
  if (new Set(years.map((year) => year.key)).size !== years.length) {
    error("MULTI_YEAR_DUPLICATE_YEAR", "A grade level is listed twice.");
  }
  for (const year of years) {
    if (
      !Number.isFinite(year.weight) ||
      year.weight <= 0 ||
      year.weight > MULTI_YEAR_LIMITS.maxWeight ||
      Math.abs(Math.round(year.weight * 100) - year.weight * 100) > 1e-6
    ) {
      error(
        "MULTI_YEAR_WEIGHT",
        "Each weight is above 0 and at most 100, with up to two decimals.",
      );
      break;
    }
  }
  return issues;
}
