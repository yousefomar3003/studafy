// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { calculateRanks, rankValue, topRanked, validateRankSettings } from "./index";

import type { RankCandidate, RoundingRule } from "./index";

const TWO_DECIMALS: RoundingRule = { decimals: 2, mode: "half_up" };

function average(id: string, value: number | null, complete = true): RankCandidate {
  return {
    id,
    status: complete ? "complete" : "incomplete",
    averagePercentage: complete ? value : null,
    gpa: null,
    weightedGpa: null,
  };
}

function gpa(id: string, plain: number | null, weighted: number | null = null): RankCandidate {
  return { id, status: "complete", averagePercentage: 80, gpa: plain, weightedGpa: weighted };
}

const ranksOf = (outcome: ReturnType<typeof calculateRanks>) =>
  outcome.ranked.map((student) => [student.id, student.rank, student.percentile]);

describe("calculateRanks", () => {
  test("ties share a rank and the next rank skips (1, 2, 2, 4)", () => {
    const outcome = calculateRanks(
      [average("d", 70), average("b", 85), average("a", 92), average("c", 85)],
      { basis: "average", rounding: TWO_DECIMALS },
    );
    expect(outcome.cohortSize).toBe(4);
    expect(ranksOf(outcome)).toEqual([
      ["a", 1, 75],
      // Tied students keep the order they were given in.
      ["b", 2, 25],
      ["c", 2, 25],
      ["d", 4, 0],
    ]);
  });

  test("incomplete results take no place and are not in the cohort", () => {
    const outcome = calculateRanks(
      [average("a", 90), average("x", null, false), average("b", 80), average("y", 99, false)],
      { basis: "average", rounding: TWO_DECIMALS },
    );
    expect(outcome.cohortSize).toBe(2);
    expect(ranksOf(outcome)).toEqual([
      ["a", 1, 50],
      ["b", 2, 0],
    ]);
    expect(outcome.unranked).toEqual(["x", "y"]);
  });

  test("values are compared after the grade's overall rounding", () => {
    const candidates = [average("a", 89.6), average("b", 90.4), average("c", 88.4)];
    // At two decimals the three differ.
    expect(
      ranksOf(calculateRanks(candidates, { basis: "average", rounding: TWO_DECIMALS })),
    ).toEqual([
      ["b", 1, 66],
      ["a", 2, 33],
      ["c", 3, 0],
    ]);
    // Rounded to whole numbers, 89.6 and 90.4 both show 90: a shared first place.
    const whole = calculateRanks(candidates, {
      basis: "average",
      rounding: { decimals: 0, mode: "half_up" },
    });
    expect(ranksOf(whole)).toEqual([
      ["a", 1, 33],
      ["b", 1, 33],
      ["c", 3, 0],
    ]);
    expect(whole.ranked[0]!.value).toBe(90);
  });

  test("percentile is the whole-number share of ranked students with a lower value", () => {
    const cohort = Array.from({ length: 200 }, (_, index) => average(`s${index}`, index / 2));
    const outcome = calculateRanks(cohort, { basis: "average", rounding: TWO_DECIMALS });
    const top = outcome.ranked[0]!;
    // 199 of 200 lower: 99.5%, rounded down.
    expect([top.rank, top.percentile]).toEqual([1, 99]);
    const bottom = outcome.ranked.at(-1)!;
    expect([bottom.rank, bottom.percentile]).toEqual([200, 0]);

    // A cohort of one: nobody is lower.
    expect(
      ranksOf(calculateRanks([average("a", 75)], { basis: "average", rounding: TWO_DECIMALS })),
    ).toEqual([["a", 1, 0]]);
    // Everyone tied: nobody is lower either.
    expect(
      ranksOf(
        calculateRanks([average("a", 75), average("b", 75), average("c", 75)], {
          basis: "average",
          rounding: TWO_DECIMALS,
        }),
      ),
    ).toEqual([
      ["a", 1, 0],
      ["b", 1, 0],
      ["c", 1, 0],
    ]);
  });

  test("an empty cohort ranks nobody", () => {
    expect(calculateRanks([], { basis: "average", rounding: TWO_DECIMALS })).toEqual({
      cohortSize: 0,
      ranked: [],
      unranked: [],
    });
  });

  test("by GPA: results without a GPA are not ranked", () => {
    const outcome = calculateRanks([gpa("a", 3.5), gpa("b", null), gpa("c", 3.9)], {
      basis: "gpa",
      rounding: TWO_DECIMALS,
    });
    expect(ranksOf(outcome)).toEqual([
      ["c", 1, 50],
      ["a", 2, 0],
    ]);
    expect(outcome.unranked).toEqual(["b"]);
  });

  test("by weighted GPA: a student without boosted subjects is ranked by the plain GPA", () => {
    const outcome = calculateRanks(
      // b has no boosted subject (no weighted GPA stored): ranked on 3.8, above a's weighted 3.6.
      [gpa("a", 3.4, 3.6), gpa("b", 3.8), gpa("c", 3.5, 4.1)],
      { basis: "weighted_gpa", rounding: TWO_DECIMALS },
    );
    expect(outcome.ranked.map((student) => [student.id, student.rank, student.value])).toEqual([
      ["c", 1, 4.1],
      ["b", 2, 3.8],
      ["a", 3, 3.6],
    ]);
    // The plain GPA ranking orders them differently.
    expect(
      calculateRanks([gpa("a", 3.4, 3.6), gpa("b", 3.8), gpa("c", 3.5, 4.1)], {
        basis: "gpa",
        rounding: TWO_DECIMALS,
      }).ranked.map((student) => student.id),
    ).toEqual(["b", "c", "a"]);
  });
});

describe("rankValue", () => {
  test("reads the basis from a complete result only", () => {
    const result: RankCandidate = {
      id: "a",
      status: "complete",
      averagePercentage: 88,
      gpa: 3.3,
      weightedGpa: 3.8,
    };
    expect(rankValue(result, "average")).toBe(88);
    expect(rankValue(result, "gpa")).toBe(3.3);
    expect(rankValue(result, "weighted_gpa")).toBe(3.8);
    expect(rankValue({ ...result, weightedGpa: null }, "weighted_gpa")).toBe(3.3);
    // No GPA at all (a percentage grade): nothing to fall back to.
    expect(rankValue({ ...result, gpa: null, weightedGpa: null }, "weighted_gpa")).toBeNull();
    expect(rankValue({ ...result, status: "incomplete" }, "average")).toBeNull();
  });
});

describe("topRanked", () => {
  const outcome = calculateRanks(
    [average("a", 95), average("b", 90), average("c", 90), average("d", 80), average("e", 70)],
    { basis: "average", rounding: TWO_DECIMALS },
  );

  test("includes every student tied within the limit", () => {
    expect(topRanked(outcome, 1).map((student) => student.id)).toEqual(["a"]);
    expect(topRanked(outcome, 2).map((student) => student.id)).toEqual(["a", "b", "c"]);
    expect(topRanked(outcome, 3).map((student) => student.id)).toEqual(["a", "b", "c"]);
    expect(topRanked(outcome, 4).map((student) => student.id)).toEqual(["a", "b", "c", "d"]);
    expect(topRanked(outcome, 50)).toHaveLength(5);
  });
});

describe("validateRankSettings", () => {
  test("a GPA basis needs a GPA result", () => {
    expect(validateRankSettings({ enabled: true, basis: "average" }, "percentage")).toEqual([]);
    expect(validateRankSettings({ enabled: true, basis: "gpa" }, "gpa")).toEqual([]);
    expect(validateRankSettings({ enabled: true, basis: "weighted_gpa" }, "gpa")).toEqual([]);
    for (const format of ["percentage", "out_of"] as const) {
      for (const basis of ["gpa", "weighted_gpa"] as const) {
        expect(validateRankSettings({ enabled: true, basis }, format)).toEqual([
          expect.objectContaining({ code: "RANK_BASIS_NEEDS_GPA", severity: "error" }),
        ]);
      }
    }
  });

  test("settings of a grade that does not rank are not checked", () => {
    expect(validateRankSettings({ enabled: false, basis: "gpa" }, "percentage")).toEqual([]);
  });
});
