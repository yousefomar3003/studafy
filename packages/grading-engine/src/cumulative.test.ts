// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { calculateCumulativeResult } from "./index";

import type { CumulativeSubjectInput } from "./index";

const ROUND_2 = { decimals: 2, mode: "half_up" } as const;

function subject(overrides: Partial<CumulativeSubjectInput> = {}): CumulativeSubjectInput {
  return {
    label: "Subject",
    status: "complete",
    includeInAverage: true,
    averageWeight: 1,
    percentage: 80,
    gpaPoints: 3,
    ...overrides,
  };
}

describe("calculateCumulativeResult", () => {
  test("weights every counted subject of every year by its coefficient", () => {
    // Year 1: Math 90 (weight 3), Arabic 70 (weight 2). Year 2: Math 80 (weight 3).
    // (90*3 + 70*2 + 80*3) / (3+2+3) = (270 + 140 + 240) / 8 = 650 / 8 = 81.25
    // GPA: (4*3 + 2*2 + 3*3) / 8 = (12 + 4 + 9) / 8 = 25 / 8 = 3.125 -> 3.13 (half up)
    const result = calculateCumulativeResult(
      [
        {
          subjects: [
            subject({ label: "Math", percentage: 90, averageWeight: 3, gpaPoints: 4 }),
            subject({ label: "Arabic", percentage: 70, averageWeight: 2, gpaPoints: 2 }),
          ],
        },
        { subjects: [subject({ label: "Math", percentage: 80, averageWeight: 3, gpaPoints: 3 })] },
      ],
      ROUND_2,
    );
    expect(result.averagePercentage).toBe(81.25);
    expect(result.gpa).toBe(3.13);
    expect(result.gpaUnavailableReason).toBeNull();
    expect(result.subjectsCounted).toBe(3);
    expect(result.totalWeight).toBe(8);
  });

  test("is a mean over subjects, not an average of yearly averages", () => {
    // Year 1 has three subjects at 60, year 2 one subject at 100, all weight 1.
    // Mean of year means would be (60 + 100) / 2 = 80; the cumulative is (60*3 + 100) / 4 = 70.
    const result = calculateCumulativeResult(
      [
        {
          subjects: [
            subject({ percentage: 60 }),
            subject({ percentage: 60 }),
            subject({ percentage: 60 }),
          ],
        },
        { subjects: [subject({ percentage: 100 })] },
      ],
      ROUND_2,
    );
    expect(result.averagePercentage).toBe(70);
  });

  test("leaves out exempt subjects and subjects outside the average", () => {
    // Only the 90 counts: the exempt and not-in-average subjects are skipped.
    const result = calculateCumulativeResult(
      [
        {
          subjects: [
            subject({ percentage: 90, gpaPoints: 4 }),
            subject({ status: "exempt", percentage: null, gpaPoints: null }),
            subject({ includeInAverage: false, percentage: 10, gpaPoints: null }),
          ],
        },
      ],
      ROUND_2,
    );
    expect(result.averagePercentage).toBe(90);
    expect(result.gpa).toBe(4);
    expect(result.subjectsCounted).toBe(1);
  });

  test("the GPA is null with the subjects named when any counted subject has no GPA points", () => {
    const result = calculateCumulativeResult(
      [
        {
          subjects: [
            subject({ label: "Math (2025-2026)", percentage: 90, gpaPoints: 4 }),
            subject({ label: "Art (2025-2026)", percentage: 70, gpaPoints: null }),
          ],
        },
      ],
      ROUND_2,
    );
    // The average is still known: (90 + 70) / 2 = 80.
    expect(result.averagePercentage).toBe(80);
    expect(result.gpa).toBeNull();
    expect(result.gpaUnavailableReason).toBe("missing_gpa_points");
    expect(result.subjectsWithoutGpaPoints).toEqual(["Art (2025-2026)"]);
  });

  test("never invents an average from incomplete subjects", () => {
    const result = calculateCumulativeResult(
      [
        {
          subjects: [
            subject({ percentage: 90 }),
            subject({ status: "incomplete", percentage: null }),
          ],
        },
      ],
      ROUND_2,
    );
    expect(result.averagePercentage).toBeNull();
    expect(result.gpa).toBeNull();
    expect(result.gpaUnavailableReason).toBe("incomplete");
  });

  test("no counted subjects gives no figures", () => {
    const result = calculateCumulativeResult([], ROUND_2);
    expect(result.averagePercentage).toBeNull();
    expect(result.gpa).toBeNull();
    expect(result.gpaUnavailableReason).toBe("no_subjects");
  });

  test("uses the school's rounding for the average", () => {
    // (85 + 86) / 2 = 85.5 -> 85 with floor at 0 decimals, 86 with half up.
    const years = [{ subjects: [subject({ percentage: 85 }), subject({ percentage: 86 })] }];
    expect(calculateCumulativeResult(years, { decimals: 0, mode: "floor" }).averagePercentage).toBe(
      85,
    );
    expect(
      calculateCumulativeResult(years, { decimals: 0, mode: "half_up" }).averagePercentage,
    ).toBe(86);
  });

  test("descriptive subjects never count, even if one claims to be in the average", () => {
    // Only Math counts: 80, GPA 3.
    const result = calculateCumulativeResult(
      [
        {
          subjects: [
            subject({ label: "Math", percentage: 80, gpaPoints: 3 }),
            subject({
              label: "Reading",
              descriptive: true,
              includeInAverage: true,
              percentage: null,
              gpaPoints: null,
            }),
          ],
        },
      ],
      ROUND_2,
    );
    expect(result.averagePercentage).toBe(80);
    expect(result.gpa).toBe(3);
    expect(result.subjectsCounted).toBe(1);
  });

  test("a year of only descriptive subjects has nothing to count", () => {
    const result = calculateCumulativeResult(
      [{ subjects: [subject({ descriptive: true, percentage: null, includeInAverage: false })] }],
      ROUND_2,
    );
    expect(result.averagePercentage).toBeNull();
    expect(result.gpaUnavailableReason).toBe("no_subjects");
  });

  test("years on different GPA scales give no cumulative GPA, but keep the average", () => {
    const result = calculateCumulativeResult(
      [
        {
          label: "2024-2025",
          gpaScaleMax: 4,
          subjects: [subject({ percentage: 90, gpaPoints: 4 })],
        },
        {
          label: "2025-2026",
          gpaScaleMax: 5,
          subjects: [subject({ percentage: 70, gpaPoints: 4 })],
        },
        { label: "2026-2027", gpaScaleMax: null, subjects: [subject({ percentage: 80 })] },
      ],
      ROUND_2,
    );
    expect(result.averagePercentage).toBe(80);
    expect(result.gpa).toBeNull();
    expect(result.gpaUnavailableReason).toBe("mixed_gpa_scales");
    expect(result.gpaScaleMax).toBeNull();
    expect(result.mixedGpaScales).toEqual([
      { label: "2024-2025", max: 4 },
      { label: "2025-2026", max: 5 },
    ]);
  });

  test("years on the same GPA scale report it", () => {
    const result = calculateCumulativeResult(
      [
        { label: "2024-2025", gpaScaleMax: 4, subjects: [subject({ gpaPoints: 4 })] },
        { label: "2025-2026", gpaScaleMax: 4, subjects: [subject({ gpaPoints: 3 })] },
      ],
      ROUND_2,
    );
    expect(result.gpa).toBe(3.5);
    expect(result.gpaScaleMax).toBe(4);
    expect(result.mixedGpaScales).toEqual([]);
  });
});
