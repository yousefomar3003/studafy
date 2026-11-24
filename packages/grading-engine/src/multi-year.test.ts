// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { calculateMultiYearResult, validateMultiYearYears } from "./index";

import type { MultiYearYearInput } from "./index";

const year = (
  key: string,
  weight: number,
  overallPercentage: number | null,
  subjects: [string, number | null][] = [],
  status: MultiYearYearInput["status"] = "finalized",
): MultiYearYearInput => ({
  key,
  weight,
  status,
  overallPercentage,
  subjects: subjects.map(([subjectId, percentage]) => ({ subjectId, percentage })),
});

describe("calculateMultiYearResult", () => {
  test("weights each year's overall and each subject over the years it has", () => {
    const result = calculateMultiYearResult([
      year("g11", 40, 80, [
        ["math", 70],
        ["arabic", 90],
      ]),
      year("g12", 60, 90, [
        ["math", 95],
        ["physics", 88.5],
      ]),
    ]);
    expect(result.status).toBe("complete");
    // 0.4 x 80 + 0.6 x 90 = 86
    expect(result.overallPercentage).toBe(86);
    expect(result.shares).toEqual([40, 60]);
    expect(result.subjects).toEqual([
      // 0.4 x 70 + 0.6 x 95 = 85
      { subjectId: "math", percentage: 85, yearsCounted: ["g11", "g12"], byYear: [70, 95] },
      { subjectId: "arabic", percentage: 90, yearsCounted: ["g11"], byYear: [90, null] },
      { subjectId: "physics", percentage: 88.5, yearsCounted: ["g12"], byYear: [null, 88.5] },
    ]);
  });

  test("weights are relative and figures follow the rounding rule", () => {
    const result = calculateMultiYearResult([year("a", 1, 70), year("b", 2, 81)], {
      decimals: 1,
      mode: "half_up",
    });
    // (70 + 162) / 3 = 77.333...
    expect(result.overallPercentage).toBe(77.3);
    expect(result.shares).toEqual([33.33, 66.67]);
  });

  test("a year not finalized yet keeps the result pending, with each year's own figures", () => {
    const result = calculateMultiYearResult([
      year("g11", 40, 80, [["math", 70]]),
      year("g12", 60, null, [], "pending"),
    ]);
    expect(result.status).toBe("pending");
    expect(result.overallPercentage).toBeNull();
    expect(result.subjects).toEqual([
      { subjectId: "math", percentage: null, yearsCounted: ["g11"], byYear: [70, null] },
    ]);
  });

  test("a missing or incomplete year makes it incomplete, even beside a pending one", () => {
    expect(
      calculateMultiYearResult([year("g11", 1, null, [], "missing"), year("g12", 1, 80)]).status,
    ).toBe("incomplete");
    expect(
      calculateMultiYearResult([
        year("g11", 1, null, [], "incomplete"),
        year("g12", 1, null, [], "pending"),
      ]).status,
    ).toBe("incomplete");
  });
});

describe("validateMultiYearYears", () => {
  test("two to six distinct grade levels with weights", () => {
    expect(
      validateMultiYearYears([
        { key: "a", weight: 40 },
        { key: "b", weight: 60 },
      ]),
    ).toEqual([]);
    const codes = (years: { key: string; weight: number }[]) =>
      validateMultiYearYears(years).map((found) => found.code);
    expect(codes([{ key: "a", weight: 1 }])).toEqual(["MULTI_YEAR_YEAR_COUNT"]);
    expect(
      codes([
        { key: "a", weight: 1 },
        { key: "a", weight: 1 },
      ]),
    ).toEqual(["MULTI_YEAR_DUPLICATE_YEAR"]);
    expect(
      codes([
        { key: "a", weight: 0 },
        { key: "b", weight: 100.5 },
      ]),
    ).toEqual(["MULTI_YEAR_WEIGHT"]);
    expect(
      codes([
        { key: "a", weight: 33.333 },
        { key: "b", weight: 1 },
      ]),
    ).toEqual(["MULTI_YEAR_WEIGHT"]);
  });
});
