// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  calculateOverallResult,
  calculateSubjectResult,
  hasErrors,
  matchBand,
  roundTo,
  summarizeWeights,
  validateGradeScale,
  validateSubjectConfig,
} from "./index";

import type {
  EngineAssessment,
  EngineCategory,
  GradeBand,
  MarkInput,
  SubjectGradingConfig,
  SubjectOutcomeForOverall,
  SubjectResult,
} from "./index";

const SCALE: GradeBand[] = [
  { label: "A", minPercentage: 90, gpaPoints: 4 },
  { label: "B", minPercentage: 80, gpaPoints: 3 },
  { label: "C", minPercentage: 70, gpaPoints: 2 },
  { label: "D", minPercentage: 50, gpaPoints: 1 },
  { label: "F", minPercentage: 0, gpaPoints: 0 },
];

const category = (
  id: string,
  weight: number | null,
  overrides: Partial<EngineCategory> = {},
): EngineCategory => ({
  id,
  name: id,
  kind: "other",
  scope: "annual",
  weight,
  aggregation: "weighted_average",
  dropLowest: 0,
  ...overrides,
});

const assessment = (
  id: string,
  categoryId: string,
  maxMarks: number,
  overrides: Partial<EngineAssessment> = {},
): EngineAssessment => ({
  id,
  categoryId,
  termId: null,
  name: id,
  maxMarks,
  weight: 1,
  mandatory: true,
  ...overrides,
});

const graded = (assessmentId: string, score: number, attempt: 1 | 2 = 1): MarkInput => ({
  assessmentId,
  attempt,
  status: "graded",
  score,
});

/** The spec's Mathematics example: homework 10, quizzes 10, midterm 20, final 60. */
function mathConfig(overrides: Partial<SubjectGradingConfig> = {}): SubjectGradingConfig {
  return {
    method: "weighted",
    maxMarks: 100,
    passPercentage: 50,
    finalExamPassPercentage: null,
    rounding: { decimals: 2, mode: "half_up" },
    missingPolicy: "incomplete",
    absentPolicy: "incomplete",
    retakePolicy: "none",
    retakeCapPercentage: null,
    scale: SCALE,
    terms: [],
    categories: [
      category("homework", 10, { kind: "homework" }),
      category("quizzes", 10, { kind: "quiz" }),
      category("midterm", 20, { kind: "midterm" }),
      category("final", 60, { kind: "final_exam" }),
    ],
    assessments: [
      assessment("hw1", "homework", 10),
      assessment("hw2", "homework", 10),
      assessment("q1", "quizzes", 20),
      assessment("q2", "quizzes", 20),
      assessment("mid", "midterm", 50),
      assessment("fin", "final", 100),
    ],
    ...overrides,
  };
}

const fullMathMarks = (): MarkInput[] => [
  graded("hw1", 8), // 80%
  graded("hw2", 10), // 100% -> homework 90%
  graded("q1", 14), // 70%
  graded("q2", 18), // 90%  -> quizzes 80%
  graded("mid", 40), // 80%
  graded("fin", 75), // 75%
];

describe("rounding", () => {
  test("half_up survives binary representation noise", () => {
    expect(roundTo(1.005, { decimals: 2, mode: "half_up" })).toBe(1.01);
    expect(roundTo(84.445, { decimals: 2, mode: "half_up" })).toBe(84.45);
    expect(roundTo(59.5, { decimals: 0, mode: "half_up" })).toBe(60);
  });

  test("half_even, floor and ceil", () => {
    expect(roundTo(2.5, { decimals: 0, mode: "half_even" })).toBe(2);
    expect(roundTo(3.5, { decimals: 0, mode: "half_even" })).toBe(4);
    expect(roundTo(2.675, { decimals: 2, mode: "half_even" })).toBe(2.68);
    expect(roundTo(89.999, { decimals: 1, mode: "floor" })).toBe(89.9);
    expect(roundTo(89.91, { decimals: 1, mode: "ceil" })).toBe(90);
  });
});

describe("grade scale", () => {
  test("matches the band with the greatest lower bound not above the percentage", () => {
    expect(matchBand(90, SCALE)?.label).toBe("A");
    expect(matchBand(89.99, SCALE)?.label).toBe("B");
    expect(matchBand(0, SCALE)?.label).toBe("F");
  });

  test("rejects contradictory, uncovered and duplicate bands", () => {
    expect(validateGradeScale(SCALE)).toEqual([]);
    const codes = validateGradeScale([
      { label: "A", minPercentage: 80, gpaPoints: 4 },
      { label: "B", minPercentage: 80, gpaPoints: 3 },
      { label: "a", minPercentage: 120, gpaPoints: null },
    ]).map((issue) => issue.code);
    expect(codes).toContain("SCALE_OVERLAP");
    expect(codes).toContain("SCALE_DUPLICATE_LABEL");
    expect(codes).toContain("SCALE_BOUND_OUT_OF_RANGE");
    expect(codes).toContain("SCALE_NO_ZERO_BAND");
    expect(validateGradeScale([]).map((issue) => issue.code)).toEqual(["SCALE_EMPTY"]);
  });
});

describe("weight validation", () => {
  test("a configuration totalling 100% is valid", () => {
    const config = mathConfig();
    expect(summarizeWeights(config)).toEqual({
      termCategoryTotal: 0,
      annualTotal: 100,
      valid: true,
    });
    expect(hasErrors(validateSubjectConfig(config))).toBe(false);
  });

  test("weights that do not total 100% are rejected with the current total", () => {
    const config = mathConfig({
      categories: [
        category("homework", 10),
        category("quizzes", 10),
        category("midterm", 20),
        category("final", 50, { kind: "final_exam" }),
      ],
    });
    const issues = validateSubjectConfig(config);
    const total = issues.find((issue) => issue.code === "ANNUAL_WEIGHT_TOTAL");
    expect(total?.severity).toBe("error");
    expect(total?.message).toContain("90%");
    expect(summarizeWeights(config).valid).toBe(false);
  });

  test("33.33 + 33.33 + 33.34 counts as 100", () => {
    const config = mathConfig({
      categories: [category("a", 33.33), category("b", 33.33), category("c", 33.34)],
      assessments: [assessment("x", "a", 10), assessment("y", "b", 10), assessment("z", "c", 10)],
    });
    expect(hasErrors(validateSubjectConfig(config))).toBe(false);
  });

  test("term categories must total 100 and terms plus annual categories must total 100", () => {
    const config = semesterConfig();
    expect(summarizeWeights(config)).toEqual({
      termCategoryTotal: 100,
      annualTotal: 100,
      valid: true,
    });
    expect(validateSubjectConfig(config).filter((issue) => issue.severity === "error")).toEqual([]);

    const broken = semesterConfig({
      terms: [
        { termId: "t1", name: "Semester 1", sequence: 1, weight: 40 },
        { termId: "t2", name: "Semester 2", sequence: 2, weight: 30 },
      ],
    });
    expect(validateSubjectConfig(broken).map((issue) => issue.code)).toContain(
      "ANNUAL_WEIGHT_TOTAL",
    );
  });

  test("structural mistakes are caught before publication", () => {
    const config = mathConfig({
      finalExamPassPercentage: 40,
      categories: [
        category("homework", 50, { dropLowest: 2 }),
        category("final", 50, { kind: "midterm" }),
      ],
      assessments: [
        assessment("hw1", "homework", 10),
        assessment("hw2", "homework", 10, { termId: "t9" }),
        assessment("ghost", "nope", 10),
      ],
    });
    const codes = validateSubjectConfig(config).map((issue) => issue.code);
    expect(codes).toContain("ASSESSMENT_SCOPE_MISMATCH");
    expect(codes).toContain("ASSESSMENT_CATEGORY_UNKNOWN");
    expect(codes).toContain("CATEGORY_WITHOUT_ASSESSMENTS");
    expect(codes).toContain("DROP_LOWEST_TOO_LARGE");
    expect(codes).toContain("FINAL_EXAM_RULE_WITHOUT_FINAL");
  });

  test("a subject without a letter scale is reported numerically", () => {
    const config = mathConfig({ scale: [] });
    expect(hasErrors(validateSubjectConfig(config))).toBe(false);
    const result = calculateSubjectResult(config, fullMathMarks());
    expect(result.percentage).toBe(78);
    expect(result.gradeLabel).toBeNull();
    expect(result.passed).toBe(true);
  });

  test("total-points grading needs no weights", () => {
    const config = mathConfig({
      method: "total_points",
      categories: [category("tests", null), category("final", null, { kind: "final_exam" })],
      assessments: [
        assessment("t1", "tests", 30),
        assessment("t2", "tests", 30),
        assessment("f", "final", 40),
      ],
    });
    expect(hasErrors(validateSubjectConfig(config))).toBe(false);
  });
});

describe("weighted subject grade", () => {
  test("the spec's Mathematics example", () => {
    // homework 90 x .10 = 9, quizzes 80 x .10 = 8, midterm 80 x .20 = 16, final 75 x .60 = 45
    const result = calculateSubjectResult(mathConfig(), fullMathMarks());
    expect(result.status).toBe("complete");
    expect(result.percentage).toBe(78);
    expect(result.marksObtained).toBe(78);
    expect(result.gradeLabel).toBe("C");
    expect(result.gpaPoints).toBe(2);
    expect(result.passed).toBe(true);
  });

  test("an 80% assessment worth 20% contributes 16 points", () => {
    const config = mathConfig({
      categories: [category("mid", 20), category("rest", 80)],
      assessments: [assessment("m", "mid", 50), assessment("r", "rest", 100)],
    });
    const result = calculateSubjectResult(config, [graded("m", 40), graded("r", 0)]);
    expect(result.percentage).toBe(16);
  });

  test("assessment weights inside a category", () => {
    const config = mathConfig({
      categories: [category("tests", 100)],
      assessments: [
        assessment("t1", "tests", 20, { weight: 1 }),
        assessment("t2", "tests", 20, { weight: 3 }),
      ],
    });
    // (50 x 1 + 100 x 3) / 4 = 87.5
    const result = calculateSubjectResult(config, [graded("t1", 10), graded("t2", 20)]);
    expect(result.percentage).toBe(87.5);
  });

  test("points aggregation inside a category weighs by maximum marks", () => {
    const config = mathConfig({
      categories: [category("tests", 100, { aggregation: "total_points" })],
      assessments: [assessment("t1", "tests", 10), assessment("t2", "tests", 90)],
    });
    // (10 + 45) / 100 = 55% (a plain mean of 100% and 50% would be 75%)
    const result = calculateSubjectResult(config, [graded("t1", 10), graded("t2", 45)]);
    expect(result.percentage).toBe(55);
  });

  test("drop lowest removes the weakest marks before averaging", () => {
    const config = mathConfig({
      categories: [category("quizzes", 100, { dropLowest: 1 })],
      assessments: [
        assessment("q1", "quizzes", 10),
        assessment("q2", "quizzes", 10),
        assessment("q3", "quizzes", 10),
      ],
    });
    const result = calculateSubjectResult(config, [
      graded("q1", 2),
      graded("q2", 8),
      graded("q3", 9),
    ]);
    expect(result.percentage).toBe(85);
    expect(
      result.annualCategories[0]!.assessments.find((a) => a.assessmentId === "q1")!.state,
    ).toBe("dropped");
  });

  test("rounding is applied once, to the final percentage", () => {
    const config = mathConfig({
      rounding: { decimals: 0, mode: "half_up" },
      categories: [category("a", 100)],
      assessments: [assessment("x", "a", 3)],
    });
    // 2/3 = 66.666...% -> 67
    const result = calculateSubjectResult(config, [graded("x", 2)]);
    expect(result.percentage).toBe(67);
    expect(result.provisionalPercentage).toBeCloseTo(66.6667, 3);
  });

  test("marks are reported on the subject's maximum marks", () => {
    const config = mathConfig({ maxMarks: 50 });
    const result = calculateSubjectResult(config, fullMathMarks());
    expect(result.percentage).toBe(78);
    expect(result.marksObtained).toBe(39);
    expect(result.maxMarks).toBe(50);
  });
});

/** Two semesters at 40% each plus an annual final at 20%; each semester: exams 60, homework 40. */
function semesterConfig(overrides: Partial<SubjectGradingConfig> = {}): SubjectGradingConfig {
  return mathConfig({
    terms: [
      { termId: "t1", name: "Semester 1", sequence: 1, weight: 40 },
      { termId: "t2", name: "Semester 2", sequence: 2, weight: 40 },
    ],
    categories: [
      category("exams", 60, { scope: "term", kind: "exam" }),
      category("homework", 40, { scope: "term", kind: "homework" }),
      category("final", 20, { scope: "annual", kind: "final_exam" }),
    ],
    assessments: [
      assessment("e1", "exams", 50, { termId: "t1" }),
      assessment("h1", "homework", 10, { termId: "t1" }),
      assessment("e2", "exams", 50, { termId: "t2" }),
      assessment("h2", "homework", 10, { termId: "t2" }),
      assessment("fin", "final", 100),
    ],
    ...overrides,
  });
}

describe("terms and annual grades", () => {
  const marks = [
    graded("e1", 40), // 80
    graded("h1", 10), // 100 -> S1 = 48 + 40 = 88
    graded("e2", 35), // 70
    graded("h2", 5), // 50 -> S2 = 42 + 20 = 62
    graded("fin", 90), // 90
  ];

  test("a term grade uses only that term's assessments", () => {
    const s1 = calculateSubjectResult(semesterConfig(), marks, { termId: "t1" });
    expect(s1.percentage).toBe(88);
    const s2 = calculateSubjectResult(semesterConfig(), marks, { termId: "t2" });
    expect(s2.percentage).toBe(62);
  });

  test("the annual grade weighs terms and annual categories", () => {
    // 88 x .4 + 62 x .4 + 90 x .2 = 35.2 + 24.8 + 18 = 78
    const annual = calculateSubjectResult(semesterConfig(), marks);
    expect(annual.percentage).toBe(78);
    expect(annual.terms.map((term) => term.percentage)).toEqual([88, 62]);
  });

  test("a term grade can be complete while the year is not", () => {
    const partial = marks.filter((mark) => mark.assessmentId !== "fin");
    expect(calculateSubjectResult(semesterConfig(), partial, { termId: "t1" }).status).toBe(
      "complete",
    );
    const annual = calculateSubjectResult(semesterConfig(), partial);
    expect(annual.status).toBe("incomplete");
    expect(annual.missingAssessments).toEqual([{ assessmentId: "fin", name: "fin" }]);
  });

  test("total-points subjects sum every point in the year", () => {
    const config = semesterConfig({
      method: "total_points",
      categories: [
        category("exams", null, { scope: "term" }),
        category("homework", null, { scope: "term" }),
        category("final", null, { scope: "annual", kind: "final_exam" }),
      ],
    });
    // (40 + 10 + 35 + 5 + 90) / (50 + 10 + 50 + 10 + 100) = 180 / 220 = 81.818...
    expect(calculateSubjectResult(config, marks).percentage).toBe(81.82);
  });
});

describe("missing, absent, excused and incomplete marks", () => {
  test("a missing mandatory mark is never a zero by default", () => {
    const marks = fullMathMarks().filter((mark) => mark.assessmentId !== "fin");
    const result = calculateSubjectResult(mathConfig(), marks);
    expect(result.status).toBe("incomplete");
    expect(result.percentage).toBeNull();
    expect(result.passed).toBeNull();
    expect(result.gradeLabel).toBeNull();
    // Preview over what is marked: (9 + 8 + 16) / 40 = 82.5
    expect(result.provisionalPercentage).toBeCloseTo(82.5, 6);
    expect(result.missingAssessments.map((item) => item.assessmentId)).toEqual(["fin"]);
  });

  test("a school that counts missing marks as zero gets a complete result", () => {
    const marks = fullMathMarks().filter((mark) => mark.assessmentId !== "fin");
    const result = calculateSubjectResult(mathConfig({ missingPolicy: "zero" }), marks);
    expect(result.status).toBe("complete");
    expect(result.percentage).toBe(33);
    expect(result.passed).toBe(false);
  });

  test("an optional assessment with no mark is simply left out", () => {
    const config = mathConfig({
      assessments: [
        ...mathConfig().assessments,
        assessment("hw3", "homework", 10, { mandatory: false }),
      ],
    });
    expect(calculateSubjectResult(config, fullMathMarks()).percentage).toBe(78);
  });

  test("an excused assessment's weight moves to the rest of its category", () => {
    const marks = fullMathMarks().map((mark) =>
      mark.assessmentId === "hw1" ? { ...mark, status: "excused" as const, score: null } : mark,
    );
    // homework = 100 (hw2 only): 10 + 8 + 16 + 45 = 79
    expect(calculateSubjectResult(mathConfig(), marks).percentage).toBe(79);
  });

  test("a fully excused category's weight moves to the other categories", () => {
    const marks = fullMathMarks().map((mark) =>
      mark.assessmentId.startsWith("hw")
        ? { ...mark, status: "excused" as const, score: null }
        : mark,
    );
    // (8 + 16 + 45) / 90 = 76.666... -> 76.67
    expect(calculateSubjectResult(mathConfig(), marks).percentage).toBe(76.67);
  });

  test("absence follows the school's absence policy", () => {
    const marks = fullMathMarks().map((mark) =>
      mark.assessmentId === "mid" ? { ...mark, status: "absent" as const, score: null } : mark,
    );
    expect(calculateSubjectResult(mathConfig(), marks).status).toBe("incomplete");
    // midterm 0: 9 + 8 + 0 + 45 = 62
    expect(calculateSubjectResult(mathConfig({ absentPolicy: "zero" }), marks).percentage).toBe(62);
  });

  test("nothing gradeable at all is incomplete, not 0% or 100%", () => {
    const excused = mathConfig().assessments.map((item): MarkInput => ({
      assessmentId: item.id,
      attempt: 1,
      status: "excused",
      score: null,
    }));
    const result = calculateSubjectResult(mathConfig(), excused);
    expect(result.status).toBe("incomplete");
    expect(result.percentage).toBeNull();
  });
});

describe("passing rules", () => {
  test("pass is decided on the rounded percentage", () => {
    const config = mathConfig({
      rounding: { decimals: 0, mode: "half_up" },
      passPercentage: 50,
      categories: [category("a", 100)],
      assessments: [assessment("x", "a", 200)],
    });
    expect(calculateSubjectResult(config, [graded("x", 99)]).passed).toBe(true); // 49.5 -> 50
    expect(calculateSubjectResult(config, [graded("x", 98)]).passed).toBe(false); // 49
  });

  test("the final exam can be required to pass on its own", () => {
    const config = mathConfig({ finalExamPassPercentage: 50 });
    const marks = [
      graded("hw1", 10),
      graded("hw2", 10),
      graded("q1", 20),
      graded("q2", 20),
      graded("mid", 50),
      graded("fin", 40), // 40% on the final
    ];
    // 10 + 10 + 20 + 24 = 64 overall, above the 50% pass mark
    const result = calculateSubjectResult(config, marks);
    expect(result.percentage).toBe(64);
    expect(result.passed).toBe(false);
    expect(result.failReasons).toEqual([
      { code: "FINAL_EXAM_BELOW_REQUIRED", categoryId: "final", required: 50, actual: 40 },
    ]);
  });
});

describe("retakes", () => {
  const marks = [...fullMathMarks().filter((m) => m.assessmentId !== "fin"), graded("fin", 30)];
  const retake = graded("fin", 80, 2);

  test("without a retake policy the retake is ignored", () => {
    // 9 + 8 + 16 + 18 = 51
    expect(calculateSubjectResult(mathConfig(), [...marks, retake]).percentage).toBe(51);
  });

  test("replace, highest and capped", () => {
    // replace: final 80 -> 9 + 8 + 16 + 48 = 81
    expect(
      calculateSubjectResult(mathConfig({ retakePolicy: "replace" }), [...marks, retake])
        .percentage,
    ).toBe(81);
    // highest of 30 and 20 is 30
    expect(
      calculateSubjectResult(mathConfig({ retakePolicy: "highest" }), [
        ...marks,
        graded("fin", 20, 2),
      ]).percentage,
    ).toBe(51);
    // capped at 50: final 50 -> 9 + 8 + 16 + 30 = 63
    const capped = calculateSubjectResult(
      mathConfig({ retakePolicy: "capped", retakeCapPercentage: 50 }),
      [...marks, retake],
    );
    expect(capped.percentage).toBe(63);
    expect(
      capped.annualCategories.find((c) => c.categoryId === "final")!.assessments[0]!.usedRetake,
    ).toBe(true);
  });

  test("a retake after an absence completes the result", () => {
    const absent = [
      ...fullMathMarks().filter((m) => m.assessmentId !== "fin"),
      { assessmentId: "fin", attempt: 1 as const, status: "absent" as const, score: null },
    ];
    expect(calculateSubjectResult(mathConfig({ retakePolicy: "replace" }), absent).status).toBe(
      "incomplete",
    );
    expect(
      calculateSubjectResult(mathConfig({ retakePolicy: "replace" }), [...absent, retake])
        .percentage,
    ).toBe(81);
  });
});

describe("overall result", () => {
  const complete = (percentage: number, passed: boolean, maxMarks = 100): SubjectResult => ({
    status: "complete",
    termId: null,
    percentage,
    provisionalPercentage: percentage,
    marksObtained: (percentage * maxMarks) / 100,
    maxMarks,
    gradeLabel: null,
    gpaPoints: null,
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
  const policy = {
    rounding: { decimals: 2, mode: "half_up" as const },
    maxFailedSubjectsForSupplementary: 2,
    scale: SCALE,
  };

  test("average, totals and promotion", () => {
    const result = calculateOverallResult(
      [
        subject("math", complete(78, true)),
        subject("arabic", complete(91, true)),
        subject("art", complete(60, true), { includeInAverage: false }),
      ],
      policy,
    );
    expect(result.averagePercentage).toBe(84.5);
    expect(result.totalObtained).toBe(169);
    expect(result.totalMax).toBe(200);
    expect(result.gradeLabel).toBe("B");
    expect(result.academicStatus).toBe("promoted");
  });

  test("coefficients weight the average", () => {
    const result = calculateOverallResult(
      [
        subject("math", complete(80, true), { averageWeight: 3 }),
        subject("art", complete(60, true)),
      ],
      policy,
    );
    expect(result.averagePercentage).toBe(75);
  });

  test("an incomplete counted subject withholds the average", () => {
    const incomplete = {
      ...complete(0, false),
      status: "incomplete" as const,
      percentage: null,
      passed: null,
    };
    const result = calculateOverallResult(
      [subject("math", complete(80, true)), subject("sci", incomplete)],
      policy,
    );
    expect(result.status).toBe("incomplete");
    expect(result.averagePercentage).toBeNull();
    expect(result.incompleteSubjectIds).toEqual(["sci"]);
    expect(result.academicStatus).toBe("incomplete");
  });

  test("exempt subjects are left out; optional failures do not hold a student back", () => {
    const result = calculateOverallResult(
      [
        subject("math", complete(80, true)),
        subject("pe", null, { exempt: true }),
        subject("music", complete(30, false), { requirement: "optional", includeInAverage: false }),
      ],
      policy,
    );
    expect(result.status).toBe("complete");
    expect(result.averagePercentage).toBe(80);
    expect(result.academicStatus).toBe("promoted");
  });

  test("supplementary up to the allowance, retained beyond it", () => {
    const failing = (n: number) =>
      Array.from({ length: 4 }, (_, i) => subject(`s${i}`, complete(i < n ? 40 : 70, i >= n)));
    expect(calculateOverallResult(failing(1), policy).academicStatus).toBe("supplementary");
    expect(calculateOverallResult(failing(2), policy).academicStatus).toBe("supplementary");
    expect(calculateOverallResult(failing(3), policy).academicStatus).toBe("retained");
    expect(calculateOverallResult(failing(3), policy).subjectsFailed).toBe(3);
  });
});
