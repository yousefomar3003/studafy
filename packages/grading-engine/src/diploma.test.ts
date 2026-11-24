// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_DIPLOMA_CONFIG,
  DEFAULT_DIPLOMA_CORE_MATRIX,
  calculateDiplomaResult,
  calculateOverallResult,
  calculateRanks,
  corePoints,
  validateDiplomaConfig,
  validateRankSettings,
} from "./index";

import type {
  DiplomaConfig,
  DiplomaCoreInput,
  DiplomaSubjectInput,
  OverallPolicy,
  SubjectOutcomeForOverall,
  SubjectResult,
} from "./index";

const CORE_BA: DiplomaCoreInput = { tok: "B", ee: "A", casComplete: true };

/** Six subjects with the given points; the first three HL, the rest SL. */
function six(points: (number | null)[], levels?: (string | null)[]): DiplomaSubjectInput[] {
  return points.map((value, index) => ({
    subjectId: `s${index + 1}`,
    points: value,
    level: levels ? (levels.at(index) ?? null) : index < 3 ? "HL" : "SL",
  }));
}

const diploma = (
  subjects: DiplomaSubjectInput[],
  core: DiplomaCoreInput = CORE_BA,
  config: DiplomaConfig = DEFAULT_DIPLOMA_CONFIG,
) => calculateDiplomaResult(subjects, core, config, 45);

const codes = (result: ReturnType<typeof diploma>) =>
  result.failingConditions.map((condition) => condition.code);

describe("the default core matrix (published IB matrix, an editable default)", () => {
  test("has all 25 TOK x EE cells", () => {
    expect(DEFAULT_DIPLOMA_CORE_MATRIX).toHaveLength(25);
  });

  test("gives 3 to 0 points, and nothing for an E", () => {
    const m = DEFAULT_DIPLOMA_CORE_MATRIX;
    expect(corePoints(m, "A", "A")).toBe(3);
    expect(corePoints(m, "A", "B")).toBe(3);
    expect(corePoints(m, "B", "A")).toBe(3);
    expect(corePoints(m, "B", "B")).toBe(2);
    expect(corePoints(m, "A", "D")).toBe(2);
    expect(corePoints(m, "B", "D")).toBe(1);
    expect(corePoints(m, "C", "C")).toBe(1);
    expect(corePoints(m, "C", "D")).toBe(0);
    expect(corePoints(m, "D", "D")).toBe(0);
    for (const grade of ["A", "B", "C", "D", "E"] as const) {
      expect(corePoints(m, "E", grade)).toBe(0);
      expect(corePoints(m, grade, "E")).toBe(0);
    }
    expect(corePoints(m, null, "A")).toBeNull();
  });
});

describe("calculateDiplomaResult", () => {
  test("awards a candidate meeting every condition: six subjects plus core points", () => {
    const result = diploma(six([7, 6, 6, 5, 5, 4]));
    expect(result).toEqual({
      status: "awarded",
      total: 36,
      max: 45,
      subjectPoints: 33,
      corePoints: 3,
      countedSubjectIds: ["s1", "s2", "s3", "s4", "s5", "s6"],
      tok: "B",
      ee: "A",
      casComplete: true,
      failingConditions: [],
      pendingReasons: [],
    });
  });

  test("counts only the best six of seven subjects", () => {
    const subjects = [...six([5, 5, 5, 5, 5, 5]), { subjectId: "s7", points: 7, level: "SL" }];
    const result = diploma(subjects);
    expect(result.subjectPoints).toBe(32);
    expect(result.countedSubjectIds).toEqual(["s7", "s1", "s2", "s3", "s4", "s5"]);
  });

  test("is pending, with no total, while TOK or EE is not graded", () => {
    const result = diploma(six([6, 6, 6, 5, 5, 5]), { tok: "A", ee: null, casComplete: true });
    expect(result.status).toBe("pending");
    expect(result.subjectPoints).toBe(33);
    expect(result.corePoints).toBeNull();
    expect(result.total).toBeNull();
    expect(result.pendingReasons).toEqual(["core_grades_missing"]);
  });

  test("is pending while a counted subject has no points", () => {
    const result = diploma(six([6, 6, null, 5, 5, 5]));
    expect(result.status).toBe("pending");
    expect(result.subjectPoints).toBeNull();
    expect(result.total).toBeNull();
    expect(result.countedSubjectIds).toEqual([]);
    expect(result.pendingReasons).toEqual(["subjects_incomplete"]);
  });

  test("fails below the minimum total", () => {
    const result = diploma(six([4, 4, 4, 4, 3, 3]), { tok: "C", ee: "D", casComplete: true });
    expect(result.total).toBe(22);
    expect(result.status).toBe("not_awarded");
    expect(result.failingConditions).toContainEqual({
      code: "MIN_TOTAL",
      required: 24,
      actual: 22,
      component: null,
      grade: null,
      level: null,
      points: null,
    });
  });

  test("an E in TOK fails at once, even while the EE grade is missing", () => {
    const result = diploma(six([7, 7, 7, 7, 7, 7]), { tok: "E", ee: null, casComplete: true });
    expect(result.status).toBe("not_awarded");
    expect(result.failingConditions).toEqual([
      expect.objectContaining({ code: "CORE_GRADE", component: "tok", grade: "E" }),
    ]);
    expect(result.pendingReasons).toEqual(["core_grades_missing"]);
  });

  test("CAS incomplete fails; CAS not recorded keeps the result pending", () => {
    expect(codes(diploma(six([6, 6, 6, 6, 6, 6]), { ...CORE_BA, casComplete: false }))).toEqual([
      "CAS_INCOMPLETE",
    ]);
    const pending = diploma(six([6, 6, 6, 6, 6, 6]), { ...CORE_BA, casComplete: null });
    expect(pending.status).toBe("pending");
    expect(pending.total).toBe(39);
    expect(pending.pendingReasons).toEqual(["cas_not_recorded"]);
  });

  test("a grade 1, three 2s or four grades of 3 or below fail", () => {
    expect(codes(diploma(six([7, 7, 7, 7, 7, 1])))).toEqual(["SUBJECTS_AT_OR_BELOW"]);
    const twos = diploma(six([7, 7, 7, 2, 2, 2], ["HL", "HL", "HL", "SL", "SL", "SL"]));
    expect(twos.failingConditions).toContainEqual(
      expect.objectContaining({ code: "SUBJECTS_AT_OR_BELOW", points: 2, required: 2, actual: 3 }),
    );
    const threes = diploma(six([7, 7, 3, 3, 3, 3]));
    expect(threes.failingConditions).toContainEqual(
      expect.objectContaining({ code: "SUBJECTS_AT_OR_BELOW", points: 3, required: 3, actual: 4 }),
    );
  });

  test("needs 12 points at HL (the best three) and 9 at SL", () => {
    const result = diploma(six([3, 4, 4, 7, 7, 7]));
    expect(result.failingConditions).toEqual([
      expect.objectContaining({ code: "LEVEL_POINTS", level: "HL", required: 12, actual: 11 }),
    ]);
    // Four HL subjects: only the best three count.
    const fourHl = diploma(six([6, 5, 4, 2, 6, 6], ["HL", "HL", "HL", "HL", "SL", "SL"]));
    expect(codes(fourHl)).toEqual([]);
    expect(codes(diploma(six([7, 7, 7, 3, 3, 2])))).toContain("LEVEL_POINTS");
  });

  test("level conditions do not apply when no subject has the level", () => {
    const result = diploma(six([3, 3, 4, 7, 7, 7], [null, null, null, null, null, null]));
    expect(codes(result)).toEqual([]);
    expect(result.status).toBe("awarded");
  });

  test("fewer subjects than counted is a failing condition", () => {
    const result = diploma(six([7, 7, 7, 7, 7]));
    expect(result.subjectPoints).toBe(35);
    expect(result.failingConditions).toContainEqual(
      expect.objectContaining({ code: "TOO_FEW_SUBJECTS", required: 6, actual: 5 }),
    );
  });

  test("conditions and the matrix are the school's data", () => {
    const lenient: DiplomaConfig = {
      countedSubjects: 3,
      coreMatrix: DEFAULT_DIPLOMA_CORE_MATRIX.map((cell) => ({ ...cell, points: 1 })),
      conditions: [],
    };
    const result = diploma(six([1, 1, 2]), { tok: "E", ee: "E", casComplete: false }, lenient);
    expect(result).toMatchObject({ status: "awarded", total: 5, corePoints: 1 });
  });
});

describe("validateDiplomaConfig", () => {
  test("the defaults are valid", () => {
    expect(validateDiplomaConfig(DEFAULT_DIPLOMA_CONFIG, 45)).toEqual([]);
  });

  test("refuses an incomplete matrix, points out of range and conditions without values", () => {
    const issues = (config: Partial<DiplomaConfig>) =>
      validateDiplomaConfig({ ...DEFAULT_DIPLOMA_CONFIG, ...config }, 45).map((i) => i.code);
    expect(issues({ coreMatrix: DEFAULT_DIPLOMA_CORE_MATRIX.slice(1) })).toEqual([
      "DIPLOMA_MATRIX_CELLS",
    ]);
    expect(
      issues({ coreMatrix: [...DEFAULT_DIPLOMA_CORE_MATRIX, DEFAULT_DIPLOMA_CORE_MATRIX[0]!] }),
    ).toEqual(["DIPLOMA_MATRIX_CELLS"]);
    expect(
      issues({
        coreMatrix: DEFAULT_DIPLOMA_CORE_MATRIX.map((cell) => ({ ...cell, points: 1.5 })),
      }),
    ).toEqual(["DIPLOMA_MATRIX_POINTS"]);
    expect(issues({ countedSubjects: 0 })).toEqual(["DIPLOMA_COUNTED_SUBJECTS"]);
    expect(
      issues({
        conditions: [
          { type: "min_total", value: null, points: null, grade: null, level: null, bestOf: null },
          {
            type: "min_level_points",
            value: 9,
            points: null,
            grade: null,
            level: " ",
            bestOf: null,
          },
        ],
      }),
    ).toEqual(["DIPLOMA_CONDITION_INVALID", "DIPLOMA_CONDITION_INVALID"]);
  });

  test("warns when the minimum total is above the maximum", () => {
    const issues = validateDiplomaConfig(DEFAULT_DIPLOMA_CONFIG, 20);
    expect(issues).toEqual([expect.objectContaining({ code: "DIPLOMA_MIN_TOTAL_ABOVE_MAX" })]);
    expect(issues[0]!.severity).toBe("warning");
  });
});

describe("calculateOverallResult with a points_total result", () => {
  const policy: OverallPolicy = {
    rounding: { decimals: 2, mode: "half_up" },
    maxFailedSubjectsForSupplementary: 0,
    scale: null,
    resultFormat: { format: "points_total", max: 45 },
  };

  function subject(
    id: string,
    points: number | null,
    level: string | null,
  ): SubjectOutcomeForOverall {
    const result: SubjectResult = {
      status: points === null ? "incomplete" : "complete",
      termId: null,
      percentage: points === null ? null : points * 10 + 5,
      provisionalPercentage: null,
      marksObtained: points === null ? null : points * 10 + 5,
      maxMarks: 100,
      gradeLabel: points === null ? null : String(points),
      gpaPoints: points,
      passed: points === null ? null : points >= 3,
      failReasons: [],
      missingAssessments: [],
      terms: [],
      annualCategories: [],
    };
    return {
      subjectId: id,
      requirement: "mandatory",
      includeInAverage: true,
      averageWeight: 1,
      courseLevel: level,
      exempt: false,
      result,
    };
  }

  const subjects = [
    subject("a", 7, "HL"),
    subject("b", 6, "HL"),
    subject("c", 6, "HL"),
    subject("d", 5, "SL"),
    subject("e", 5, "SL"),
    subject("f", 4, "SL"),
  ];

  test("the display is the diploma total out of 45", () => {
    const overall = calculateOverallResult(subjects, policy, CORE_BA);
    expect(overall.display).toEqual({ format: "points_total", value: 36, max: 45 });
    expect(overall.diploma).toMatchObject({ status: "awarded", subjectPoints: 33, corePoints: 3 });
    // The average is still worked out for the record.
    expect(overall.averagePercentage).toBe(60);
  });

  test("without core grades the total is pending and the display has no value", () => {
    const overall = calculateOverallResult(subjects, policy);
    expect(overall.status).toBe("complete");
    expect(overall.display).toEqual({ format: "points_total", value: null, max: 45 });
    expect(overall.diploma?.status).toBe("pending");
  });

  test("an incomplete result still reports the diploma as pending", () => {
    const overall = calculateOverallResult(
      [...subjects.slice(0, 5), subject("f", null, "SL")],
      policy,
      CORE_BA,
    );
    expect(overall.status).toBe("incomplete");
    expect(overall.display).toBeNull();
    expect(overall.diploma?.pendingReasons).toEqual(["subjects_incomplete"]);
  });

  test("other formats carry no diploma", () => {
    const overall = calculateOverallResult(subjects, { ...policy, resultFormat: undefined });
    expect(overall.diploma).toBeUndefined();
    expect("diploma" in overall).toBe(false);
  });
});

describe("class rank by the diploma total", () => {
  test("ranks by the total; a pending total takes no place", () => {
    const outcome = calculateRanks(
      [
        {
          id: "a",
          status: "complete",
          averagePercentage: 70,
          gpa: null,
          weightedGpa: null,
          pointsTotal: 38,
        },
        {
          id: "b",
          status: "complete",
          averagePercentage: 90,
          gpa: null,
          weightedGpa: null,
          pointsTotal: 35,
        },
        {
          id: "c",
          status: "complete",
          averagePercentage: 95,
          gpa: null,
          weightedGpa: null,
          pointsTotal: null,
        },
      ],
      { basis: "points_total", rounding: { decimals: 2, mode: "half_up" } },
    );
    expect(outcome.ranked.map((s) => [s.id, s.rank])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(outcome.unranked).toEqual(["c"]);
  });

  test("the points-total basis needs a points-total result", () => {
    expect(validateRankSettings({ enabled: true, basis: "points_total" }, "points_total")).toEqual(
      [],
    );
    expect(
      validateRankSettings({ enabled: true, basis: "points_total" }, "gpa").map((i) => i.code),
    ).toEqual(["RANK_BASIS_NEEDS_POINTS_TOTAL"]);
    expect(
      validateRankSettings({ enabled: true, basis: "gpa" }, "points_total").map((i) => i.code),
    ).toEqual(["RANK_BASIS_NEEDS_GPA"]);
  });
});
