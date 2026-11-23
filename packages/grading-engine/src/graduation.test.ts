// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { evaluateGraduationRequirements, validateGraduationRule } from "./index";

import type {
  GraduationEvaluationInput,
  GraduationRuleDefinition,
  GraduationSubjectInput,
} from "./index";

const ROUND_2 = { decimals: 2, mode: "half_up" } as const;

const subject = (
  subjectId: string,
  overrides: Partial<GraduationSubjectInput> = {},
): GraduationSubjectInput => ({
  subjectId,
  label: subjectId,
  status: "complete",
  includeInAverage: true,
  averageWeight: 1,
  percentage: 80,
  gpaPoints: 3,
  credits: 1,
  passed: true,
  ...overrides,
});

const rule = (
  type: GraduationRuleDefinition["type"],
  overrides: Partial<GraduationRuleDefinition> = {},
): GraduationRuleDefinition => ({
  id: type,
  type,
  minValue: null,
  groupName: null,
  subjectIds: [],
  externalExamId: null,
  ...overrides,
});

/**
 * Grade 9: English 1 credit (A, 4), Algebra 1 (B, 3), PE 0.5 pass/fail out of the average.
 * Grade 10: English 1 (C, 2), Geometry 1 failed (F, 0).
 * Credits earned 3.5 of 4.5 attempted; GPA (4 + 3 + 2 + 0) / 4 = 2.25; average 72.5.
 */
const twoYears = (): GraduationEvaluationInput["years"] => [
  {
    label: "Grade 9",
    subjects: [
      subject("eng9", { gpaPoints: 4, percentage: 95 }),
      subject("algebra", { gpaPoints: 3, percentage: 85 }),
      subject("pe", {
        credits: 0.5,
        includeInAverage: false,
        descriptive: true,
        percentage: null,
        gpaPoints: null,
      }),
    ],
  },
  {
    label: "Grade 10",
    subjects: [
      subject("eng10", { gpaPoints: 2, percentage: 75 }),
      subject("geometry", { gpaPoints: 0, percentage: 35, passed: false }),
    ],
  },
];

function evaluate(
  rules: GraduationRuleDefinition[],
  overrides: Partial<GraduationEvaluationInput> = {},
) {
  return evaluateGraduationRequirements({
    rules,
    years: twoYears(),
    examResults: [],
    currentYearPending: false,
    rounding: ROUND_2,
    ...overrides,
  });
}

describe("credit rules", () => {
  test("total credits earned count pass/fail and out-of-average subjects, not failed ones", () => {
    const met = evaluate([rule("total_credits", { minValue: 3.5 })]);
    expect(met.rules[0]).toMatchObject({ status: "met", current: 3.5, required: 3.5 });
    const short = evaluate([rule("total_credits", { minValue: 24 })]);
    expect(short.rules[0]).toMatchObject({ status: "not_met", current: 3.5, required: 24 });
    expect(short.status).toBe("not_met");
  });

  test("credits in a named group of subjects", () => {
    const english = rule("group_credits", {
      minValue: 4,
      groupName: "English",
      subjectIds: ["eng9", "eng10", "eng11"],
    });
    expect(evaluate([english]).rules[0]).toMatchObject({
      status: "not_met",
      current: 2,
      required: 4,
    });
  });

  test("a year still to be finalized makes a rule not reached yet pending", () => {
    const result = evaluate([rule("total_credits", { minValue: 24 })], {
      currentYearPending: true,
    });
    expect(result.rules[0]).toMatchObject({ status: "pending", current: 3.5 });
    expect(result.status).toBe("pending");
    // Credits already earned are never taken away: reached is met, pending year or not.
    expect(
      evaluate([rule("total_credits", { minValue: 3 })], { currentYearPending: true }).status,
    ).toBe("met");
  });

  test("no finalized years: nothing earned", () => {
    const result = evaluate([rule("total_credits", { minValue: 1 })], { years: [] });
    expect(result.rules[0]).toMatchObject({ status: "not_met", current: 0 });
  });

  test("an exempt subject earns no credits", () => {
    const result = evaluate([rule("total_credits", { minValue: 4 })], {
      years: [{ subjects: [subject("a", { credits: 3 }), subject("b", { status: "exempt" })] }],
    });
    expect(result.rules[0]).toMatchObject({ status: "not_met", current: 3 });
  });
});

describe("subjects passed", () => {
  test("every listed subject must be passed in some year; the missing ones are named", () => {
    const result = evaluate([
      rule("subjects_passed", {
        groupName: "Core",
        subjectIds: ["algebra", "geometry", "eng9"],
      }),
    ]);
    expect(result.rules[0]).toMatchObject({
      status: "not_met",
      current: 2,
      required: 3,
      missingSubjectIds: ["geometry"],
    });
  });

  test("a subject failed one year and passed on a retake counts as passed", () => {
    const years = [
      ...twoYears(),
      { label: "Grade 11", subjects: [subject("geometry", { gpaPoints: 2 })] },
    ];
    const result = evaluate(
      [rule("subjects_passed", { groupName: "Maths", subjectIds: ["algebra", "geometry"] })],
      { years },
    );
    expect(result.rules[0]).toMatchObject({ status: "met", current: 2, required: 2 });
  });

  test("a pass/fail subject that was passed counts", () => {
    const result = evaluate([rule("subjects_passed", { groupName: "PE", subjectIds: ["pe"] })]);
    expect(result.rules[0]?.status).toBe("met");
  });
});

describe("cumulative GPA and average", () => {
  test("the cumulative GPA and average are the transcript's", () => {
    const result = evaluate([
      rule("cumulative_gpa", { minValue: 2 }),
      rule("cumulative_average", { minValue: 75 }),
    ]);
    expect(result.rules[0]).toMatchObject({ status: "met", current: 2.25, required: 2 });
    expect(result.rules[1]).toMatchObject({ status: "not_met", current: 72.5, required: 75 });
    expect(result).toMatchObject({ status: "not_met", rulesMet: 1, rulesTotal: 2 });
  });

  test("stays pending while the current year is not finalized, even above the minimum", () => {
    const result = evaluate([rule("cumulative_gpa", { minValue: 2 })], {
      currentYearPending: true,
    });
    expect(result.rules[0]).toMatchObject({ status: "pending", current: 2.25 });
  });

  test("a GPA that cannot be worked out is not met", () => {
    const result = evaluate([rule("cumulative_gpa", { minValue: 2 })], {
      years: [{ subjects: [subject("a", { gpaPoints: null })] }],
    });
    expect(result.rules[0]).toMatchObject({ status: "not_met", current: null });
  });
});

describe("external exams", () => {
  const sat = (minValue: number | null) =>
    rule("external_exam", { externalExamId: "sat", minValue });

  test("recorded at all, or with the best total at or above the minimum", () => {
    const examResults = [
      { examId: "sat", totalScore: 1100 },
      { examId: "sat", totalScore: 1250 },
      { examId: "ielts", totalScore: 7 },
    ];
    expect(evaluate([sat(null)], { examResults }).rules[0]).toMatchObject({
      status: "met",
      current: 1250,
      required: null,
    });
    expect(evaluate([sat(1200)], { examResults }).rules[0]?.status).toBe("met");
    expect(evaluate([sat(1300)], { examResults }).rules[0]).toMatchObject({
      status: "not_met",
      current: 1250,
      required: 1300,
    });
  });

  test("not sat yet: pending while the student is still studying", () => {
    expect(evaluate([sat(null)]).rules[0]?.status).toBe("not_met");
    expect(evaluate([sat(null)], { currentYearPending: true }).rules[0]?.status).toBe("pending");
  });

  test("a result without a total does not meet a minimum total", () => {
    const examResults = [{ examId: "sat", totalScore: null }];
    expect(evaluate([sat(null)], { examResults }).rules[0]?.status).toBe("met");
    expect(evaluate([sat(1000)], { examResults }).rules[0]).toMatchObject({
      status: "not_met",
      current: null,
    });
  });
});

test("a set with no rules is met", () => {
  expect(evaluate([])).toMatchObject({ status: "met", rulesMet: 0, rulesTotal: 0 });
});

describe("rule validation", () => {
  const codes = (definition: Omit<GraduationRuleDefinition, "id">) =>
    validateGraduationRule(definition).map((issue) => issue.code);

  test("valid rules have no issues", () => {
    for (const definition of [
      rule("total_credits", { minValue: 24 }),
      rule("group_credits", { minValue: 4, groupName: "English", subjectIds: ["a"] }),
      rule("subjects_passed", { groupName: "Core", subjectIds: ["a", "b"] }),
      rule("cumulative_gpa", { minValue: 2.5 }),
      rule("cumulative_average", { minValue: 60 }),
      rule("external_exam", { externalExamId: "sat" }),
      rule("external_exam", { externalExamId: "sat", minValue: 1200 }),
    ]) {
      expect(codes(definition)).toEqual([]);
    }
  });

  test("each rule type asks for what it needs and nothing else", () => {
    expect(codes(rule("total_credits"))).toEqual(["GRADUATION_MIN_REQUIRED"]);
    expect(codes(rule("group_credits", { minValue: 4, groupName: " " }))).toEqual([
      "GRADUATION_GROUP_NAME_REQUIRED",
      "GRADUATION_SUBJECTS_REQUIRED",
    ]);
    expect(
      codes(rule("subjects_passed", { groupName: "Core", subjectIds: ["a", "a"], minValue: 1 })),
    ).toEqual(["GRADUATION_DUPLICATE_SUBJECT", "GRADUATION_MIN_NOT_ALLOWED"]);
    expect(codes(rule("external_exam"))).toEqual(["GRADUATION_EXAM_REQUIRED"]);
    expect(
      codes(rule("total_credits", { minValue: 4, subjectIds: ["a"], externalExamId: "sat" })),
    ).toEqual(["GRADUATION_SUBJECTS_NOT_ALLOWED", "GRADUATION_EXAM_NOT_ALLOWED"]);
  });

  test("minimums are positive, in range and have at most two decimals", () => {
    expect(codes(rule("cumulative_gpa", { minValue: 11 }))).toEqual([
      "GRADUATION_MIN_OUT_OF_RANGE",
    ]);
    expect(codes(rule("cumulative_average", { minValue: 0 }))).toEqual([
      "GRADUATION_MIN_OUT_OF_RANGE",
    ]);
    expect(codes(rule("total_credits", { minValue: 1.005 }))).toEqual(["GRADUATION_MIN_PRECISION"]);
    expect(codes(rule("total_credits", { minValue: 0.1 }))).toEqual([]);
  });
});
