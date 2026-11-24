// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  EQUIVALENCY_EXAMPLES,
  convertEquivalencyValue,
  estimateTawjihiEquivalency,
  validateEquivalencyParts,
} from "./index";

import type {
  EquivalencyExamResultInput,
  EquivalencyPartDefinition,
  EquivalencyStudentInput,
} from "./index";

const part = (
  fields: Partial<EquivalencyPartDefinition> & Pick<EquivalencyPartDefinition, "type">,
): EquivalencyPartDefinition => ({
  label: fields.type,
  weight: 100,
  required: true,
  examIds: [],
  bestCount: null,
  minCount: null,
  requiredSubjectIds: [],
  gradePercentages: [],
  conversion: null,
  requireAwarded: false,
  gpaBasis: null,
  ...fields,
});

const table = (rows: [number, number][]) => ({
  mode: "table" as const,
  bands: rows.map(([min, percentage]) => ({ min, percentage })),
  slope: null,
  intercept: null,
});

const IGCSE_GRADES = [
  { grade: "A*", percentage: 98 },
  { grade: "A", percentage: 93 },
  { grade: "B", percentage: 85 },
  { grade: "C", percentage: 75 },
];

const igcse = (overrides: Partial<EquivalencyPartDefinition> = {}) =>
  part({
    type: "exam_subjects",
    label: "IGCSE",
    examIds: ["igcse"],
    bestCount: 3,
    gradePercentages: IGCSE_GRADES,
    ...overrides,
  });

const result = (
  subjectId: string | null,
  grade: string | null,
  overrides: Partial<EquivalencyExamResultInput> = {},
): EquivalencyExamResultInput => ({
  examId: "igcse",
  subjectId,
  grade,
  total: null,
  ...overrides,
});

const student = (overrides: Partial<EquivalencyStudentInput> = {}): EquivalencyStudentInput => ({
  examResults: [],
  diploma: null,
  gpa: null,
  weightedGpa: null,
  gpaScaleMax: null,
  currentYearPending: false,
  ...overrides,
});

describe("exam subjects (IGCSE / A Level)", () => {
  test("the best N subjects count, the best sitting per subject, grades matched loosely", () => {
    const estimate = estimateTawjihiEquivalency(
      [igcse()],
      student({
        examResults: [
          result("math", "B"),
          result("math", "a*"), // a resit: the better one counts
          result("arabic", "A"),
          result("physics", " C "),
          result("art", "B"),
        ],
      }),
    );
    expect(estimate.status).toBe("estimated");
    // math 98, arabic 93, then B (art) over C (physics): (98 + 93 + 85) / 3 = 92
    expect(estimate.percentage).toBe(92);
    const [breakdown] = estimate.parts;
    expect(breakdown).toMatchObject({ status: "counted", percentage: 92, share: 100 });
    expect(
      breakdown!.subjects.filter((step) => step.counted).map((step) => step.subjectId),
    ).toEqual(["math", "arabic", "art"]);
    expect(
      breakdown!.subjects.find((step) => step.grade === "B" && step.subjectId === "math"),
    ).toMatchObject({ counted: false, percentage: 85 });
  });

  test("required subjects count even when they are not among the best", () => {
    const estimate = estimateTawjihiEquivalency(
      [igcse({ bestCount: 2, requiredSubjectIds: ["arabic"] })],
      student({
        examResults: [result("math", "A*"), result("art", "A"), result("arabic", "C")],
      }),
    );
    // arabic 75 (required) + math 98 = 86.5
    expect(estimate.percentage).toBe(86.5);
    expect(estimate.parts[0]!.subjects.find((step) => step.subjectId === "arabic")).toMatchObject({
      counted: true,
      requiredSubject: true,
    });
  });

  test("a required subject without a result, or too few subjects, is missing data", () => {
    const estimate = estimateTawjihiEquivalency(
      [igcse({ requiredSubjectIds: ["english"] })],
      student({ examResults: [result("math", "A"), result("art", "B")] }),
    );
    expect(estimate.status).toBe("incomplete");
    expect(estimate.percentage).toBeNull();
    expect(estimate.issues.map((found) => [found.code, found.kind])).toEqual([
      ["REQUIRED_SUBJECT_MISSING", "missing"],
      ["TOO_FEW_SUBJECTS", "missing"],
    ]);
    expect(estimate.issues[0]!.subjectId).toBe("english");
    expect(estimate.issues[1]).toMatchObject({ required: 3, actual: 2 });
    // The steps are still shown.
    expect(estimate.parts[0]!.subjects).toHaveLength(2);
  });

  test("a grade without a percentage is noted and does not count", () => {
    const estimate = estimateTawjihiEquivalency(
      [igcse({ bestCount: 2, minCount: 1 })],
      student({ examResults: [result("math", "A"), result("art", "U")] }),
    );
    expect(estimate.status).toBe("estimated");
    expect(estimate.percentage).toBe(93);
    expect(estimate.issues).toEqual([
      expect.objectContaining({ code: "UNMAPPED_GRADE", kind: "note", grade: "U" }),
    ]);
  });

  test("results of other exams, without a subject or a grade are ignored", () => {
    const estimate = estimateTawjihiEquivalency(
      [igcse()],
      student({
        examResults: [
          result("math", "A", { examId: "a-level" }),
          result(null, "A"),
          result("art", null),
        ],
      }),
    );
    expect(estimate.status).toBe("incomplete");
    expect(estimate.issues[0]!.code).toBe("NO_EXAM_RESULTS");
  });
});

describe("IB Diploma total", () => {
  const ib = part({
    type: "diploma_total",
    requireAwarded: true,
    conversion: table([
      [24, 70],
      [35, 90],
      [42, 99],
    ]),
  });

  test("an awarded total converts through the table", () => {
    const estimate = estimateTawjihiEquivalency(
      [ib],
      student({ diploma: { status: "awarded", total: 36, max: 45 } }),
    );
    expect(estimate).toMatchObject({ status: "estimated", percentage: 90 });
    expect(estimate.parts[0]).toMatchObject({ sourceValue: 36, sourceMax: 45 });
  });

  test("not awarded is not eligible; pending or no result is missing data", () => {
    expect(
      estimateTawjihiEquivalency(
        [ib],
        student({ diploma: { status: "not_awarded", total: 30, max: 45 } }),
      ),
    ).toMatchObject({ status: "not_eligible", percentage: null });
    const pending = estimateTawjihiEquivalency(
      [ib],
      student({ diploma: { status: "pending", total: 30, max: 45 } }),
    );
    expect(pending.status).toBe("incomplete");
    expect(pending.issues[0]!.code).toBe("DIPLOMA_PENDING");
    expect(estimateTawjihiEquivalency([ib], student()).issues[0]!.code).toBe("NO_DIPLOMA_RESULT");
    // Without requireAwarded, a not-awarded total still converts.
    expect(
      estimateTawjihiEquivalency(
        [{ ...ib, requireAwarded: false }],
        student({ diploma: { status: "not_awarded", total: 30, max: 45 } }),
      ).percentage,
    ).toBe(70);
  });

  test("a total below the table gives no estimate", () => {
    const estimate = estimateTawjihiEquivalency(
      [{ ...ib, requireAwarded: false }],
      student({ diploma: { status: "not_awarded", total: 20, max: 45 } }),
    );
    expect(estimate.status).toBe("not_eligible");
    expect(estimate.issues[0]).toMatchObject({
      code: "BELOW_CONVERSION_TABLE",
      required: 24,
      actual: 20,
    });
  });
});

describe("American: GPA and SAT", () => {
  const gpa = part({
    type: "gpa",
    weight: 70,
    gpaBasis: "gpa",
    conversion: { mode: "linear", bands: [], slope: 25, intercept: 0 },
  });
  const sat = part({
    type: "exam_total",
    weight: 30,
    required: false,
    examIds: ["sat"],
    conversion: table([
      [1200, 85],
      [1400, 95],
    ]),
  });

  test("weighted mean of the parts, the best SAT total", () => {
    const estimate = estimateTawjihiEquivalency(
      [gpa, sat],
      student({
        gpa: 3.6,
        gpaScaleMax: 4,
        examResults: [
          { examId: "sat", subjectId: null, grade: null, total: 1250 },
          { examId: "sat", subjectId: null, grade: null, total: 1420 },
        ],
      }),
    );
    // 0.7 x 90 + 0.3 x 95 = 91.5
    expect(estimate).toMatchObject({ status: "estimated", percentage: 91.5 });
    expect(estimate.parts.map((p) => [p.percentage, p.share, p.sourceValue])).toEqual([
      [90, 70, 3.6],
      [95, 30, 1420],
    ]);
  });

  test("an optional part without data is skipped and the others take its share", () => {
    const estimate = estimateTawjihiEquivalency([gpa, sat], student({ gpa: 3, gpaScaleMax: 4 }));
    expect(estimate).toMatchObject({ status: "estimated", percentage: 75 });
    expect(estimate.parts.map((p) => [p.status, p.share])).toEqual([
      ["counted", 100],
      ["skipped", null],
    ]);
    expect(estimate.issues.map((found) => [found.code, found.kind])).toEqual([
      ["NO_EXAM_TOTAL", "note"],
      ["OPTIONAL_PART_SKIPPED", "note"],
    ]);
  });

  test("the weighted GPA falls back to the GPA; a linear result is clamped; pending is noted", () => {
    const weighted = { ...gpa, gpaBasis: "weighted_gpa" as const };
    expect(
      estimateTawjihiEquivalency([weighted], student({ gpa: 3, weightedGpa: 3.4 })).percentage,
    ).toBe(85);
    expect(estimateTawjihiEquivalency([weighted], student({ gpa: 3 })).percentage).toBe(75);
    const clamped = estimateTawjihiEquivalency(
      [gpa],
      student({ gpa: 4.5, currentYearPending: true }),
    );
    expect(clamped.percentage).toBe(100);
    expect(clamped.issues[0]).toMatchObject({ code: "CURRENT_YEAR_PENDING", kind: "note" });
    expect(estimateTawjihiEquivalency([gpa], student()).issues[0]!.code).toBe("NO_GPA");
  });

  test("not eligible outranks missing data", () => {
    const estimate = estimateTawjihiEquivalency(
      [
        part({ type: "gpa", gpaBasis: "gpa", conversion: table([[2, 70]]) }),
        part({ type: "exam_total", examIds: ["sat"], conversion: table([[400, 60]]) }),
      ],
      student({ gpa: 1.5 }),
    );
    expect(estimate.status).toBe("not_eligible");
  });
});

describe("conversion", () => {
  test("a table takes the highest band reached, in any order", () => {
    const conversion = table([
      [2, 70],
      [3.5, 92],
      [3, 85],
    ]);
    expect(convertEquivalencyValue(3.2, conversion)).toEqual({ percentage: 85 });
    expect(convertEquivalencyValue(3.5, conversion)).toEqual({ percentage: 92 });
    expect(convertEquivalencyValue(1.9, conversion)).toEqual({ below: 2 });
  });

  test("a formula rounds to two decimals", () => {
    expect(
      convertEquivalencyValue(37, { mode: "linear", bands: [], slope: 2.2222, intercept: 0 }),
    ).toEqual({ percentage: 82.22 });
  });
});

describe("validation", () => {
  test("the examples are valid once their exams are chosen", () => {
    for (const example of EQUIVALENCY_EXAMPLES) {
      const parts = example.parts.map((examplePart) => ({
        ...examplePart,
        examIds: examplePart.examPresetKeys.length > 0 ? ["exam"] : [],
      }));
      expect(validateEquivalencyParts(parts)).toEqual([]);
    }
  });

  test("each type needs its own fields and no others", () => {
    const codes = (parts: EquivalencyPartDefinition[]) =>
      validateEquivalencyParts(parts).map((found) => found.code);
    expect(codes([])).toEqual(["EQUIVALENCY_NO_PARTS"]);
    expect(codes([igcse({ examIds: [], gradePercentages: [] })])).toEqual([
      "EQUIVALENCY_EXAMS",
      "EQUIVALENCY_GRADES",
    ]);
    expect(
      codes([
        igcse({
          bestCount: 2,
          minCount: 3,
          requiredSubjectIds: ["a", "b", "c"],
          gradePercentages: [
            { grade: "A", percentage: 90 },
            { grade: " a ", percentage: 101 },
          ],
        }),
      ]),
    ).toEqual([
      "EQUIVALENCY_MIN_COUNT",
      "EQUIVALENCY_TOO_MANY_REQUIRED",
      "EQUIVALENCY_DUPLICATE_GRADE",
      "EQUIVALENCY_PERCENTAGE",
    ]);
    expect(codes([part({ type: "gpa" })])).toEqual([
      "EQUIVALENCY_GPA_BASIS",
      "EQUIVALENCY_CONVERSION_REQUIRED",
    ]);
    expect(
      codes([
        part({
          type: "exam_total",
          conversion: table([
            [1, 50],
            [1, 60],
          ]),
          weight: 0,
        }),
      ]),
    ).toEqual(["EQUIVALENCY_WEIGHT", "EQUIVALENCY_EXAM_REQUIRED", "EQUIVALENCY_DUPLICATE_BAND"]);
    expect(
      codes([
        part({
          type: "diploma_total",
          examIds: ["x"],
          conversion: { mode: "linear", bands: [], slope: null, intercept: 1 },
        }),
      ]),
    ).toEqual(["EQUIVALENCY_EXAMS_NOT_ALLOWED", "EQUIVALENCY_LINEAR"]);
    expect(
      codes([
        part({ type: "gpa", gpaBasis: "gpa", requireAwarded: true, conversion: table([[0, 1]]) }),
      ]),
    ).toEqual(["EQUIVALENCY_AWARDED_NOT_ALLOWED"]);
    const messages = validateEquivalencyParts([igcse(), igcse({ label: " " })]).map(
      (found) => found.message,
    );
    expect(messages).toEqual(["Part 2: Name the part."]);
  });
});
