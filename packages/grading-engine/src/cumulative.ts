import { roundTo } from "./rounding";

import type { RoundingRule } from "./types";

/**
 * Cumulative figures across several years of finalized results, for an academic transcript.
 *
 * Each year's overall average already weights subjects by their coefficient (`averageWeight`), so
 * the cumulative average does the same across every year at once: one weighted mean over every
 * counted subject of every year, not an average of yearly averages. A year with many heavy subjects
 * therefore counts for more than a year with a few light ones, exactly as it did in its own year.
 *
 * A subject counts when it is complete, not exempt and included in the average. Nothing is invented:
 *  - any counted subject without a percentage makes the cumulative average null;
 *  - the cumulative GPA is the same weighted mean over each subject's GPA points, and is null when
 *    any counted subject has none (its grade scale band carries no points), with the reason and the
 *    subjects named so the school can fix its scale;
 *  - the cumulative GPA is also null when the years were graded on different GPA scales (out of 4
 *    one year, out of 5 another): averaging those points would mix two scales, so the years and
 *    their maximums are reported instead.
 *
 * Descriptive subjects (graded with descriptors, never with a percentage) never count, exactly as
 * they never count in their own year's average.
 */

export interface CumulativeSubjectInput {
  /** Shown when the GPA cannot be worked out, e.g. "Mathematics (2025-2026)". */
  label: string;
  status: "complete" | "incomplete" | "exempt";
  includeInAverage: boolean;
  averageWeight: number;
  percentage: number | null;
  gpaPoints: number | null;
  /** Graded with descriptors: never counted. */
  descriptive?: boolean;
}

export interface CumulativeYearInput {
  subjects: readonly CumulativeSubjectInput[];
  /** Shown when the GPA scales differ, e.g. "2025-2026". */
  label?: string;
  /** The GPA maximum the year's result was shown on (4, 5...); null when it was not a GPA. */
  gpaScaleMax?: number | null;
}

export type CumulativeGpaUnavailableReason =
  "no_subjects" | "incomplete" | "missing_gpa_points" | "mixed_gpa_scales";

export interface CumulativeResult {
  /** Weighted mean percentage over every counted subject of every year; null when not computable. */
  averagePercentage: number | null;
  /** Weighted mean GPA points; null when any counted subject has none. */
  gpa: number | null;
  gpaUnavailableReason: CumulativeGpaUnavailableReason | null;
  /** Counted subjects with no GPA points, by label (only when that is the reason). */
  subjectsWithoutGpaPoints: string[];
  /** The GPA maximum every GPA year shares (4, 5...); null when none was a GPA, or they differ. */
  gpaScaleMax: number | null;
  /** Each GPA year and its maximum (only when the maximums differ). */
  mixedGpaScales: { label: string; max: number }[];
  /** Number of subject results counted, across all years. */
  subjectsCounted: number;
  /** Sum of the counted subjects' weights. */
  totalWeight: number;
}

/** GPA points are always shown to two decimals, rounded half up. */
export const GPA_ROUNDING: RoundingRule = { decimals: 2, mode: "half_up" };

export function calculateCumulativeResult(
  years: readonly CumulativeYearInput[],
  rounding: RoundingRule,
): CumulativeResult {
  const counted = years
    .flatMap((year) => year.subjects)
    .filter(
      (subject) => subject.status !== "exempt" && subject.includeInAverage && !subject.descriptive,
    );
  const gpaYears = years.flatMap((year) =>
    year.gpaScaleMax === null || year.gpaScaleMax === undefined
      ? []
      : [{ label: year.label ?? "", max: year.gpaScaleMax }],
  );
  const scaleMaxima = new Set(gpaYears.map((year) => year.max));
  const scale = {
    gpaScaleMax: scaleMaxima.size === 1 ? gpaYears[0]!.max : null,
    mixedGpaScales: [] as { label: string; max: number }[],
  };
  const totalWeight = counted.reduce((total, subject) => total + subject.averageWeight, 0);

  if (counted.length === 0 || totalWeight <= 0) {
    return {
      averagePercentage: null,
      gpa: null,
      gpaUnavailableReason: "no_subjects",
      subjectsWithoutGpaPoints: [],
      ...scale,
      subjectsCounted: counted.length,
      totalWeight,
    };
  }

  const incomplete = counted.some(
    (subject) => subject.status !== "complete" || subject.percentage === null,
  );
  if (incomplete) {
    return {
      averagePercentage: null,
      gpa: null,
      gpaUnavailableReason: "incomplete",
      subjectsWithoutGpaPoints: [],
      ...scale,
      subjectsCounted: counted.length,
      totalWeight,
    };
  }

  const averagePercentage = roundTo(
    counted.reduce((total, subject) => total + subject.percentage! * subject.averageWeight, 0) /
      totalWeight,
    rounding,
  );

  if (scaleMaxima.size > 1) {
    return {
      averagePercentage,
      gpa: null,
      gpaUnavailableReason: "mixed_gpa_scales",
      subjectsWithoutGpaPoints: [],
      gpaScaleMax: null,
      mixedGpaScales: gpaYears,
      subjectsCounted: counted.length,
      totalWeight,
    };
  }

  const withoutPoints = counted.filter((subject) => subject.gpaPoints === null);
  if (withoutPoints.length > 0) {
    return {
      averagePercentage,
      gpa: null,
      gpaUnavailableReason: "missing_gpa_points",
      subjectsWithoutGpaPoints: withoutPoints.map((subject) => subject.label),
      ...scale,
      subjectsCounted: counted.length,
      totalWeight,
    };
  }

  const gpa = roundTo(
    counted.reduce((total, subject) => total + subject.gpaPoints! * subject.averageWeight, 0) /
      totalWeight,
    GPA_ROUNDING,
  );
  return {
    averagePercentage,
    gpa,
    gpaUnavailableReason: null,
    subjectsWithoutGpaPoints: [],
    ...scale,
    subjectsCounted: counted.length,
    totalWeight,
  };
}
