// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  calculateTermSummary,
  getDefaultBoundaries,
  matchBoundary,
  round2,
  type ClassResult,
} from "./index";

describe("round2", () => {
  test("rounds half away from zero to two decimals", () => {
    expect(round2(88.745)).toBe(88.75);
    expect(round2(3.14159)).toBe(3.14);
    expect(round2(100)).toBe(100);
  });
});

describe("matchBoundary", () => {
  const boundaries = [
    { label: "A", min: 90, gpa_points: 4 },
    { label: "B", min: 80, gpa_points: 3 },
    { label: "C", min: 70, gpa_points: 2 },
    { label: "D", min: 60, gpa_points: 1 },
    { label: "F", min: 0, gpa_points: 0 },
  ];

  test("picks the highest boundary the percentage clears, independent of input order", () => {
    expect(matchBoundary(88.75, boundaries)).toEqual({ label: "B", gpaPoints: 3 });
    expect(matchBoundary(100, boundaries)).toEqual({ label: "A", gpaPoints: 4 });
    expect(matchBoundary(0, boundaries)).toEqual({ label: "F", gpaPoints: 0 });
    expect(matchBoundary(75, boundaries)).toEqual({ label: "C", gpaPoints: 2 });
  });

  test("handles unordered and null-gpa boundaries", () => {
    const unordered = [boundaries[4], boundaries[2], boundaries[0]];
    expect(matchBoundary(85, unordered)).toEqual({ label: "C", gpaPoints: 2 });

    const noGpa = [
      { label: "Excellent", min: 90, gpa_points: null },
      { label: "Good", min: 80, gpa_points: null },
    ];
    expect(matchBoundary(92, noGpa)).toEqual({ label: "Excellent", gpaPoints: null });
  });

  test("returns null when no boundary is crossed", () => {
    expect(matchBoundary(-1, boundaries)).toBeNull();
    expect(matchBoundary(-1, [])).toBeNull();
  });
});

describe("getDefaultBoundaries", () => {
  test("letter and gpa schemes share the standard five-letter scale", () => {
    expect(getDefaultBoundaries("letter")).toHaveLength(5);
    expect(getDefaultBoundaries("letter")[0]).toMatchObject({ label: "A", min: 90, max: 100 });
    expect(getDefaultBoundaries("gpa")).toEqual(getDefaultBoundaries("letter"));
  });

  test("percentage and numeric schemes carry no GPA points", () => {
    for (const schemeType of ["percentage", "numeric"] as const) {
      const boundaries = getDefaultBoundaries(schemeType);
      expect(boundaries).toHaveLength(5);
      expect(boundaries.every((boundary) => boundary.gpa_points === null)).toBe(true);
    }
  });

  test("pass_fail has exactly two boundaries", () => {
    expect(getDefaultBoundaries("pass_fail")).toEqual([
      { label: "Pass", min: 60, max: 100, gpa_points: null },
      { label: "Fail", min: 0, max: 59, gpa_points: null },
    ]);
  });
});

describe("calculateTermSummary", () => {
  test("credit-weighted GPA and average, with credits totalled", () => {
    const classes: ClassResult[] = [
      { classId: "a", creditHours: 3, percentage: 95, gpaPoints: 4 },
      { classId: "b", creditHours: 1, percentage: 70, gpaPoints: 2 },
    ];
    expect(calculateTermSummary(classes)).toEqual({
      term_gpa: 3.5,
      term_average_percentage: 88.75,
      total_credits: 4,
    });
  });

  test("GPA is null when any class has no GPA points", () => {
    const classes: ClassResult[] = [
      { classId: "a", creditHours: 3, percentage: 95, gpaPoints: 4 },
      { classId: "b", creditHours: 1, percentage: 70, gpaPoints: null },
    ];
    const summary = calculateTermSummary(classes);
    expect(summary.term_gpa).toBeNull();
    expect(summary.term_average_percentage).toBe(88.75);
    expect(summary.total_credits).toBe(4);
  });

  test("no classes yields zero credits and null aggregates", () => {
    expect(calculateTermSummary([])).toEqual({
      term_gpa: null,
      term_average_percentage: null,
      total_credits: 0,
    });
  });
});
