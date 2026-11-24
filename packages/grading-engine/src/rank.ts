import { roundTo } from "./rounding";

import type { ResultFormatKind, RoundingRule, ValidationIssue } from "./types";

/**
 * Class rank and percentile (000257): where a student's finalized result places them among the
 * students of their section or grade level for the same period. Used for American transcripts and
 * for the top-student lists of Jordanian and Egyptian schools ("الأوائل").
 *
 * The rules, in one place:
 *
 *  - Only complete results are ranked. An incomplete result (or one without a value on the chosen
 *    basis) is left out: it takes no place and does not count in the cohort.
 *  - Values are compared after the grade's overall rounding, so two averages that show the same
 *    (89.995 and 90 at no decimals) share a place.
 *  - Ties share a rank and the next rank skips ("competition" ranking): 1, 2, 2, 4.
 *  - Percentile: the share of ranked students with a lower value, as a whole-number percentage
 *    rounded down. The top student of 200 is at the 99th percentile (199 of 200 are lower); a
 *    cohort of one is at the 0th.
 */

/** What students are ranked by. */
export type RankBasis = "average" | "gpa" | "weighted_gpa" | "points_total";

/** Who a student is ranked against: their section, or every section of their grade level. */
export type RankScope = "section" | "grade_level";

/** One student's finalized overall result, as ranking reads it. */
export interface RankCandidate {
  /** Any key the caller uses to find the student again (a student id, or finalization|student). */
  id: string;
  status: "complete" | "incomplete";
  averagePercentage: number | null;
  /** The GPA, when the result is shown as a GPA; null for any other result format. */
  gpa: number | null;
  /** The weighted GPA, stored only when a counted subject carries a boost (000253). */
  weightedGpa: number | null;
  /** The IB Diploma total of a `points_total` result; null or absent otherwise (000263). */
  pointsTotal?: number | null;
}

export interface RankedStudent {
  id: string;
  /** 1 for the best; tied students share the rank and the next one skips. */
  rank: number;
  /** Whole-number percentage of the ranked students with a lower value. */
  percentile: number;
  /** The value compared, after rounding. */
  value: number;
}

export interface RankOutcome {
  /** How many students were ranked: the denominator of "3rd of 120". */
  cohortSize: number;
  /** Ranked students, best first; tied students keep the order they were given in. */
  ranked: RankedStudent[];
  /** Ids of the candidates left out (incomplete, or no value on the basis). */
  unranked: string[];
}

/**
 * The value a result is ranked by, or null when it cannot be ranked.
 *
 *  - average       the overall average percentage.
 *  - gpa           the GPA; only a GPA result has one.
 *  - weighted_gpa  the weighted GPA. It is stored only when a counted subject is boosted, so a
 *                  student without boosted subjects is ranked by their plain GPA (which is then
 *                  their weighted GPA too).
 *  - points_total  the IB Diploma total (out of 45); a student whose total is pending (core grades
 *                  missing) takes no place.
 */
export function rankValue(candidate: RankCandidate, basis: RankBasis): number | null {
  if (candidate.status !== "complete") return null;
  switch (basis) {
    case "average":
      return candidate.averagePercentage;
    case "gpa":
      return candidate.gpa;
    case "weighted_gpa":
      return candidate.gpa === null ? null : (candidate.weightedGpa ?? candidate.gpa);
    case "points_total":
      return candidate.pointsTotal ?? null;
  }
}

/** Rank a cohort. Pure: the caller decides who is in it (see {@link RankScope}). */
export function calculateRanks(
  candidates: readonly RankCandidate[],
  policy: { basis: RankBasis; rounding: RoundingRule },
): RankOutcome {
  const valued: { id: string; value: number; order: number }[] = [];
  const unranked: string[] = [];
  candidates.forEach((candidate, order) => {
    const raw = rankValue(candidate, policy.basis);
    if (raw === null || !Number.isFinite(raw)) unranked.push(candidate.id);
    else valued.push({ id: candidate.id, value: roundTo(raw, policy.rounding), order });
  });
  valued.sort((a, b) => b.value - a.value || a.order - b.order);

  const cohortSize = valued.length;
  const ranked: RankedStudent[] = [];
  let index = 0;
  while (index < cohortSize) {
    const value = valued.at(index)!.value;
    let end = index;
    while (end < cohortSize && valued.at(end)!.value === value) end += 1;
    const lower = cohortSize - end;
    const percentile = Math.floor((lower * 100) / cohortSize);
    for (let tied = index; tied < end; tied += 1) {
      ranked.push({ id: valued.at(tied)!.id, rank: index + 1, percentile, value });
    }
    index = end;
  }
  return { cohortSize, ranked, unranked };
}

/**
 * The top `limit` places, ties included: every student whose rank is at most `limit`. With ranks
 * 1, 2, 2, 4 the top 3 is three students and the top 2 is three too.
 */
export function topRanked(outcome: RankOutcome, limit: number): RankedStudent[] {
  return outcome.ranked.filter((student) => student.rank <= limit);
}

/**
 * A grade's rank settings against its result format: a GPA basis needs a grade that shows its
 * result as a GPA (no other result has GPA values to rank by), and the points-total basis a grade
 * whose result is the IB Diploma total.
 */
export function validateRankSettings(
  settings: { enabled: boolean; basis: RankBasis },
  resultFormat: ResultFormatKind,
): ValidationIssue[] {
  if (!settings.enabled || settings.basis === "average") return [];
  if (settings.basis === "points_total") {
    return resultFormat === "points_total"
      ? []
      : [
          {
            code: "RANK_BASIS_NEEDS_POINTS_TOTAL",
            severity: "error",
            message:
              "Ranking by the diploma total needs the grade's result shown as a points total. Rank by the average, or change the result format.",
          },
        ];
  }
  if (resultFormat === "gpa") return [];
  return [
    {
      code: "RANK_BASIS_NEEDS_GPA",
      severity: "error",
      message:
        settings.basis === "gpa"
          ? "Ranking by GPA needs the grade's result shown as a GPA. Rank by the average, or change the result format."
          : "Ranking by weighted GPA needs the grade's result shown as a GPA. Rank by the average, or change the result format.",
    },
  ];
}
