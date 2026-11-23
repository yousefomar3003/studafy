// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  calculateCumulativeResult,
  calculateOverallResult,
  calculateSubjectResult,
  validateSubjectConfig,
} from "./index";

import type {
  CumulativeSubjectInput,
  GradeBand,
  OverallPolicy,
  SubjectGradingConfig,
  SubjectOutcomeForOverall,
  SubjectResult,
} from "./index";

/** An American A-F scale on 4.0 (B+ carries 3.3, so boosts exercise decimal sums). */
const SCALE: GradeBand[] = [
  { label: "A", minPercentage: 90, gpaPoints: 4 },
  { label: "B+", minPercentage: 85, gpaPoints: 3.3 },
  { label: "B", minPercentage: 80, gpaPoints: 3 },
  { label: "C", minPercentage: 70, gpaPoints: 2 },
  { label: "D", minPercentage: 60, gpaPoints: 1 },
  { label: "F", minPercentage: 0, gpaPoints: 0 },
];

/** One assessment out of 100 in one category: the score is the subject's percentage. */
function config(overrides: Partial<SubjectGradingConfig> = {}): SubjectGradingConfig {
  return {
    method: "weighted",
    maxMarks: 100,
    passPercentage: 60,
    finalExamPassPercentage: null,
    rounding: { decimals: 2, mode: "half_up" },
    missingPolicy: "incomplete",
    absentPolicy: "incomplete",
    retakePolicy: "none",
    retakeCapPercentage: null,
    scale: SCALE,
    terms: [],
    categories: [
      {
        id: "exam",
        name: "Exam",
        kind: "exam",
        scope: "annual",
        weight: 100,
        aggregation: "weighted_average",
        dropLowest: 0,
      },
    ],
    assessments: [
      {
        id: "a1",
        categoryId: "exam",
        termId: null,
        name: "Exam",
        maxMarks: 100,
        weight: 1,
        mandatory: true,
      },
    ],
    ...overrides,
  };
}

const scored = (score: number) => [
  { assessmentId: "a1", attempt: 1 as const, status: "graded" as const, score },
];

describe("weighted GPA points of a subject", () => {
  test("a passed boosted subject adds its boost to the band's points", () => {
    const result = calculateSubjectResult(config({ gpaBoost: 0.5 }), scored(87));
    expect(result.gpaPoints).toBe(3.3);
    expect(result.weightedGpaPoints).toBe(3.8);
  });

  test("a failed boosted subject keeps its plain points", () => {
    const result = calculateSubjectResult(config({ gpaBoost: 1 }), scored(40));
    expect(result.passed).toBe(false);
    expect(result.gpaPoints).toBe(0);
    expect(result.weightedGpaPoints).toBe(0);
  });

  test("no boost, or a snapshot from before boosts, has no weighted points", () => {
    expect(calculateSubjectResult(config({ gpaBoost: 0 }), scored(95)).weightedGpaPoints).toBe(
      null,
    );
    expect(calculateSubjectResult(config(), scored(95)).weightedGpaPoints).toBeNull();
  });

  test("a band without GPA points has no weighted points", () => {
    const scale = SCALE.map((band) => ({ ...band, gpaPoints: null }));
    const result = calculateSubjectResult(config({ gpaBoost: 1, scale }), scored(95));
    expect(result.gpaPoints).toBeNull();
    expect(result.weightedGpaPoints).toBeNull();
  });

  test("an incomplete result has no weighted points", () => {
    const result = calculateSubjectResult(config({ gpaBoost: 1 }), []);
    expect(result.status).toBe("incomplete");
    expect(result.weightedGpaPoints).toBeNull();
  });
});

describe("overall weighted GPA and credits", () => {
  const complete = (
    gpaPoints: number | null,
    passed: boolean,
    weightedGpaPoints: number | null = null,
  ): SubjectResult => ({
    status: "complete",
    termId: null,
    percentage: passed ? 80 : 40,
    provisionalPercentage: passed ? 80 : 40,
    marksObtained: passed ? 80 : 40,
    maxMarks: 100,
    gradeLabel: null,
    gpaPoints,
    weightedGpaPoints,
    passed,
    failReasons: [],
    missingAssessments: [],
    terms: [],
    annualCategories: [],
  });
  const subject = (
    subjectId: string,
    result: SubjectResult | null,
    overrides: Partial<SubjectOutcomeForOverall> = {},
  ): SubjectOutcomeForOverall => ({
    subjectId,
    requirement: "mandatory",
    includeInAverage: true,
    averageWeight: 1,
    exempt: false,
    result,
    ...overrides,
  });
  const gpa: OverallPolicy = {
    rounding: { decimals: 2, mode: "half_up" },
    maxFailedSubjectsForSupplementary: 2,
    scale: null,
    resultFormat: { format: "gpa", max: 4 },
  };

  test("the weighted GPA sits beside the unchanged GPA, weighted by the coefficients", () => {
    // GPA: (4*1 + 3*1 + 3*2) / 4 = 13 / 4 = 3.25. Weighted: AP math 5, honors history 3.5:
    // (5*1 + 3.5*1 + 3*2) / 4 = 14.5 / 4 = 3.625 -> 3.63.
    const result = calculateOverallResult(
      [
        subject("math", complete(4, true, 5)),
        subject("history", complete(3, true, 3.5)),
        subject("english", complete(3, true), { averageWeight: 2 }),
      ],
      gpa,
    );
    expect(result.display).toEqual({ format: "gpa", value: 3.25, max: 4 });
    expect(result.weightedGpa).toBe(3.63);
  });

  test("no weighted GPA when nothing is boosted, or the result is not a GPA", () => {
    const subjects = [subject("math", complete(4, true)), subject("art", complete(3, true))];
    expect(calculateOverallResult(subjects, gpa).weightedGpa).toBeNull();
    const boosted = [subject("math", complete(4, true, 5))];
    expect(
      calculateOverallResult(boosted, { ...gpa, resultFormat: { format: "percentage", max: 100 } })
        .weightedGpa,
    ).toBeNull();
  });

  test("no weighted GPA when the GPA itself is withheld", () => {
    const result = calculateOverallResult(
      [subject("math", complete(4, true, 5)), subject("art", complete(null, true))],
      gpa,
    );
    expect(result.display?.value).toBeNull();
    expect(result.weightedGpa).toBeNull();
  });

  test("credits attempted count complete subjects; credits earned only passed ones", () => {
    const result = calculateOverallResult(
      [
        subject("math", complete(4, true), { credits: 1 }),
        subject("history", complete(0, false), { credits: 1 }),
        subject("pe", complete(3, true), { credits: 0.5 }),
        subject("club", complete(3, true)),
        subject("music", complete(3, true), { credits: 2, includeInAverage: false }),
        subject("art", null, { credits: 3, exempt: true }),
      ],
      gpa,
    );
    expect(result.creditsAttempted).toBe(2.5);
    expect(result.creditsEarned).toBe(1.5);
  });

  test("credits are null when no counted subject has credits", () => {
    const result = calculateOverallResult([subject("math", complete(4, true))], gpa);
    expect(result.creditsAttempted).toBeNull();
    expect(result.creditsEarned).toBeNull();
  });

  test("an incomplete overall still reports the complete subjects' credits", () => {
    const result = calculateOverallResult(
      [
        subject("math", complete(4, true), { credits: 1 }),
        subject("science", null, { credits: 1 }),
      ],
      gpa,
    );
    expect(result.status).toBe("incomplete");
    expect(result.weightedGpa).toBeNull();
    expect(result.creditsAttempted).toBe(1);
    expect(result.creditsEarned).toBe(1);
  });
});

describe("cumulative weighted GPA and credits", () => {
  const ROUND_2 = { decimals: 2, mode: "half_up" } as const;
  const subject = (overrides: Partial<CumulativeSubjectInput> = {}): CumulativeSubjectInput => ({
    label: "Subject",
    status: "complete",
    includeInAverage: true,
    averageWeight: 1,
    percentage: 80,
    gpaPoints: 3,
    passed: true,
    ...overrides,
  });

  test("weighted GPA and credits across years", () => {
    // GPA: (4 + 3 + 3) / 3 = 3.33. Weighted: (5 + 3 + 3) / 3 = 3.666... -> 3.67.
    const result = calculateCumulativeResult(
      [
        { subjects: [subject({ gpaPoints: 4, weightedGpaPoints: 5, credits: 1 })] },
        {
          subjects: [
            subject({ credits: 1 }),
            subject({ credits: 0.5, passed: false, gpaPoints: 3 }),
          ],
        },
      ],
      ROUND_2,
    );
    expect(result.gpa).toBe(3.33);
    expect(result.weightedGpa).toBe(3.67);
    expect(result.creditsAttempted).toBe(2.5);
    expect(result.creditsEarned).toBe(2);
  });

  test("no weighted GPA without a boosted subject; no credits without credits", () => {
    const result = calculateCumulativeResult([{ subjects: [subject()] }], ROUND_2);
    expect(result.gpa).toBe(3);
    expect(result.weightedGpa).toBeNull();
    expect(result.creditsAttempted).toBeNull();
    expect(result.creditsEarned).toBeNull();
  });

  test("the weighted GPA is unavailable for the same reasons as the GPA", () => {
    const missing = calculateCumulativeResult(
      [{ subjects: [subject({ weightedGpaPoints: 5, credits: 1 }), subject({ gpaPoints: null })] }],
      ROUND_2,
    );
    expect(missing.gpaUnavailableReason).toBe("missing_gpa_points");
    expect(missing.weightedGpa).toBeNull();
    expect(missing.creditsAttempted).toBe(1);

    const mixed = calculateCumulativeResult(
      [
        { subjects: [subject({ weightedGpaPoints: 5 })], label: "2024", gpaScaleMax: 4 },
        { subjects: [subject()], label: "2025", gpaScaleMax: 5 },
      ],
      ROUND_2,
    );
    expect(mixed.gpaUnavailableReason).toBe("mixed_gpa_scales");
    expect(mixed.weightedGpa).toBeNull();
  });

  test("incomplete subjects count no credits", () => {
    const result = calculateCumulativeResult(
      [{ subjects: [subject({ credits: 1 }), subject({ status: "incomplete", credits: 1 })] }],
      ROUND_2,
    );
    expect(result.gpaUnavailableReason).toBe("incomplete");
    expect(result.creditsAttempted).toBe(1);
    expect(result.creditsEarned).toBe(1);
  });
});

describe("credits validation", () => {
  test("warns when credits differ from the coefficient", () => {
    const issues = validateSubjectConfig(config(), { averageWeight: 1, credits: 0.5 });
    expect(issues.filter((issue) => issue.code === "CREDITS_DIFFER_FROM_COEFFICIENT")).toEqual([
      expect.objectContaining({ severity: "warning" }),
    ]);
  });

  test("no warning when they match, credits are unset or no weighting is given", () => {
    const codes = (weighting?: { averageWeight: number; credits: number | null }) =>
      validateSubjectConfig(config(), weighting).map((issue) => issue.code);
    expect(codes({ averageWeight: 1, credits: 1 })).not.toContain(
      "CREDITS_DIFFER_FROM_COEFFICIENT",
    );
    expect(codes({ averageWeight: 3, credits: null })).not.toContain(
      "CREDITS_DIFFER_FROM_COEFFICIENT",
    );
    expect(codes()).not.toContain("CREDITS_DIFFER_FROM_COEFFICIENT");
  });
});
