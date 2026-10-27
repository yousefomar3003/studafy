import type { GradeBand, RoundingRule, ValidationIssue } from "./types";

/** Tolerance for comparing computed percentages against thresholds and weight totals. */
export const EPSILON = 1e-9;

/** Weight totals may drift by this much (33.33 + 33.33 + 33.34) and still count as 100. */
export const WEIGHT_TOLERANCE = 0.001;

/**
 * Round a non-negative number by the school's rule.
 *
 * Binary floating point stores 1.005 as 1.00499999..., so a naive `Math.round(x * 100) / 100`
 * rounds it down. Scaling and then cutting the result to 12 significant digits removes that
 * representation noise before the rounding decision, which keeps `half_up` honest for every value
 * a mark sheet can produce.
 */
export function roundTo(value: number, rule: RoundingRule): number {
  const factor = 10 ** rule.decimals;
  const scaled = Number((value * factor).toPrecision(12));
  let rounded: number;
  switch (rule.mode) {
    case "floor":
      rounded = Math.floor(scaled);
      break;
    case "ceil":
      rounded = Math.ceil(scaled);
      break;
    case "half_even": {
      const floor = Math.floor(scaled);
      const fraction = scaled - floor;
      if (Math.abs(fraction - 0.5) < EPSILON) {
        rounded = floor % 2 === 0 ? floor : floor + 1;
      } else {
        rounded = Math.round(scaled);
      }
      break;
    }
    case "half_up":
      rounded = Math.floor(scaled + 0.5);
      break;
  }
  return Number((rounded / factor).toFixed(rule.decimals));
}

/** `a >= b`, forgiving floating-point noise. */
export function atLeast(a: number, b: number): boolean {
  return a + EPSILON >= b;
}

/**
 * The band a percentage falls in: the band with the greatest lower bound not above it.
 * Returns null only for an empty or malformed scale (one without a 0 band).
 */
export function matchBand(percentage: number, scale: readonly GradeBand[]): GradeBand | null {
  let best: GradeBand | null = null;
  for (const band of scale) {
    if (atLeast(percentage, band.minPercentage)) {
      if (best === null || band.minPercentage > best.minPercentage) best = band;
    }
  }
  return best;
}

/**
 * A scale is a list of lower bounds. Bands cannot overlap or leave gaps by construction (each
 * runs up to the next lower bound), so what can go wrong is: no band starting at 0 (marks below
 * the lowest band have no grade), two bands sharing a lower bound (contradictory), duplicate
 * labels, and bounds outside 0-100.
 */
export function validateGradeScale(scale: readonly GradeBand[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (scale.length === 0) {
    issues.push({
      code: "SCALE_EMPTY",
      severity: "error",
      message: "The grading scale has no bands.",
    });
    return issues;
  }

  const seenMins = new Map<number, string>();
  const seenLabels = new Set<string>();
  for (const band of scale) {
    if (!(band.minPercentage >= 0 && band.minPercentage <= 100)) {
      issues.push({
        code: "SCALE_BOUND_OUT_OF_RANGE",
        severity: "error",
        message: `Band "${band.label}" starts at ${band.minPercentage}%, outside 0-100%.`,
        ref: band.label,
      });
    }
    const clash = seenMins.get(band.minPercentage);
    if (clash !== undefined) {
      issues.push({
        code: "SCALE_OVERLAP",
        severity: "error",
        message: `Bands "${clash}" and "${band.label}" both start at ${band.minPercentage}%.`,
        ref: band.label,
      });
    }
    seenMins.set(band.minPercentage, band.label);
    const label = band.label.trim().toLowerCase();
    if (seenLabels.has(label)) {
      issues.push({
        code: "SCALE_DUPLICATE_LABEL",
        severity: "error",
        message: `The label "${band.label}" is used by more than one band.`,
        ref: band.label,
      });
    }
    seenLabels.add(label);
  }

  if (!scale.some((band) => band.minPercentage === 0)) {
    issues.push({
      code: "SCALE_NO_ZERO_BAND",
      severity: "error",
      message: "The lowest band must start at 0% so that every percentage has a grade.",
    });
  }

  const ordered = [...scale].sort((a, b) => a.minPercentage - b.minPercentage);
  for (let index = 1; index < ordered.length; index += 1) {
    const lower = ordered.at(index - 1)!;
    const higher = ordered.at(index)!;
    if (
      lower.gpaPoints !== null &&
      higher.gpaPoints !== null &&
      higher.gpaPoints < lower.gpaPoints
    ) {
      issues.push({
        code: "SCALE_GPA_NOT_MONOTONIC",
        severity: "warning",
        message: `Band "${higher.label}" is higher than "${lower.label}" but carries fewer GPA points.`,
        ref: higher.label,
      });
    }
  }

  return issues;
}
