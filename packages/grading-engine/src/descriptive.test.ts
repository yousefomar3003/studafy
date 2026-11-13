// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  calculateOverallResult,
  calculateSubjectResult,
  hasErrors,
  nearestDescriptor,
  summarizeWeights,
  validateSubjectConfig,
} from "./index";

import type {
  EngineDescriptor,
  MarkInput,
  SubjectGradingConfig,
  SubjectOutcomeForOverall,
} from "./index";

const SCALE: EngineDescriptor[] = [
  { id: "ex", label: "Excellent", points: 4, notAchieved: false },
  { id: "vg", label: "Very good", points: 3, notAchieved: false },
  { id: "gd", label: "Good", points: 2, notAchieved: false },
  { id: "ni", label: "Needs improvement", points: 1, notAchieved: false },
];

const NO_POINTS = SCALE.map((descriptor) => ({ ...descriptor, points: null }));

/** Reading: two skills in term 1, one in term 2. */
function readingConfig(overrides: Partial<SubjectGradingConfig> = {}): SubjectGradingConfig {
  return {
    method: "descriptive",
    maxMarks: 100,
    passPercentage: 50,
    finalExamPassPercentage: null,
    rounding: { decimals: 2, mode: "half_up" },
    missingPolicy: "incomplete",
    absentPolicy: "incomplete",
    retakePolicy: "none",
    retakeCapPercentage: null,
    scale: [],
    terms: [
      { termId: "t1", name: "Term 1", sequence: 1, weight: 0 },
      { termId: "t2", name: "Term 2", sequence: 2, weight: 0 },
    ],
    categories: [
      {
        id: "reading",
        name: "Reading",
        kind: "other",
        scope: "term",
        weight: null,
        aggregation: "weighted_average",
        dropLowest: 0,
      },
    ],
    assessments: [
      {
        id: "fluent",
        categoryId: "reading",
        termId: "t1",
        name: "Reads fluently",
        maxMarks: 1,
        weight: 1,
        mandatory: true,
      },
      {
        id: "letters",
        categoryId: "reading",
        termId: "t1",
        name: "Knows letters",
        maxMarks: 1,
        weight: 1,
        mandatory: true,
      },
      {
        id: "story",
        categoryId: "reading",
        termId: "t2",
        name: "Retells a story",
        maxMarks: 1,
        weight: 1,
        mandatory: true,
      },
    ],
    descriptors: SCALE,
    ...overrides,
  };
}

const pick = (assessmentId: string, descriptorId: string): MarkInput => ({
  assessmentId,
  attempt: 1,
  status: "graded",
  score: null,
  descriptorId,
});

describe("descriptive subjects", () => {
  test("the subject descriptor is the one nearest the average points", () => {
    const result = calculateSubjectResult(readingConfig(), [
      pick("fluent", "ex"),
      pick("letters", "vg"),
      pick("story", "vg"),
    ]);
    expect(result.status).toBe("complete");
    expect(result.descriptive).toBe(true);
    expect(result.percentage).toBeNull();
    expect(result.marksObtained).toBeNull();
    expect(result.gpaPoints).toBeNull();
    expect(result.descriptor).toEqual({ id: "vg", label: "Very good", averagePoints: 3.33 });
    expect(result.gradeLabel).toBe("Very good");
    expect(result.passed).toBe(true);
    const skills = result.terms.flatMap((term) => term.categories.flatMap((c) => c.assessments));
    expect(skills.map((skill) => skill.descriptorLabel)).toEqual([
      "Excellent",
      "Very good",
      "Very good",
    ]);
  });

  test("a tie goes to the higher descriptor", () => {
    expect(nearestDescriptor(3.5, SCALE)?.id).toBe("ex");
    expect(nearestDescriptor(1.49, SCALE)?.id).toBe("ni");
  });

  test("a term result only looks at that term's skills", () => {
    const result = calculateSubjectResult(
      readingConfig(),
      [pick("fluent", "gd"), pick("letters", "gd")],
      { termId: "t1" },
    );
    expect(result.status).toBe("complete");
    expect(result.descriptor?.label).toBe("Good");
  });

  test("a missing mandatory skill makes the result incomplete", () => {
    const result = calculateSubjectResult(readingConfig(), [pick("fluent", "ex")]);
    expect(result.status).toBe("incomplete");
    expect(result.passed).toBeNull();
    expect(result.missingAssessments.map((m) => m.assessmentId)).toEqual(["letters", "story"]);
  });

  test("the zero policies use the lowest descriptor", () => {
    const result = calculateSubjectResult(readingConfig({ missingPolicy: "zero" }), [
      pick("fluent", "ex"),
      { assessmentId: "letters", attempt: 1, status: "absent", score: null },
    ]);
    // letters is absent (policy incomplete) -> still missing.
    expect(result.status).toBe("incomplete");
    const withAbsentZero = calculateSubjectResult(
      readingConfig({ missingPolicy: "zero", absentPolicy: "zero" }),
      [
        pick("fluent", "ex"),
        { assessmentId: "letters", attempt: 1, status: "absent", score: null },
      ],
    );
    expect(withAbsentZero.status).toBe("complete");
    // 4 + 1 + 1 (story missing -> lowest) = 2 -> Good
    expect(withAbsentZero.descriptor?.label).toBe("Good");
  });

  test("excused skills are left out", () => {
    const result = calculateSubjectResult(readingConfig(), [
      pick("fluent", "ex"),
      { assessmentId: "letters", attempt: 1, status: "excused", score: null },
      pick("story", "ex"),
    ]);
    expect(result.descriptor?.label).toBe("Excellent");
  });

  test("without points only the skills are reported, and the subject is passed", () => {
    const result = calculateSubjectResult(readingConfig({ descriptors: NO_POINTS }), [
      pick("fluent", "ni"),
      pick("letters", "ni"),
      pick("story", "ni"),
    ]);
    expect(result.status).toBe("complete");
    expect(result.descriptor).toBeNull();
    expect(result.gradeLabel).toBeNull();
    expect(result.passed).toBe(true);
  });

  test('a subject landing on a "not achieved" descriptor is not passed', () => {
    const scale = SCALE.map((d) => (d.id === "ni" ? { ...d, notAchieved: true } : d));
    const result = calculateSubjectResult(readingConfig({ descriptors: scale }), [
      pick("fluent", "ni"),
      pick("letters", "ni"),
      pick("story", "gd"),
    ]);
    expect(result.passed).toBe(false);
    expect(result.failReasons).toEqual([
      { code: "DESCRIPTOR_NOT_ACHIEVED", descriptor: "Needs improvement" },
    ]);
  });

  test("a descriptive subject never counts in the overall average", () => {
    const reading = calculateSubjectResult(readingConfig(), [
      pick("fluent", "ex"),
      pick("letters", "ex"),
      pick("story", "ex"),
    ]);
    const subjects: SubjectOutcomeForOverall[] = [
      {
        subjectId: "reading",
        requirement: "mandatory",
        includeInAverage: true,
        averageWeight: 1,
        exempt: false,
        result: reading,
      },
    ];
    const overall = calculateOverallResult(subjects, {
      rounding: { decimals: 2, mode: "half_up" },
      maxFailedSubjectsForSupplementary: 0,
      scale: null,
    });
    expect(overall.status).toBe("complete");
    expect(overall.averagePercentage).toBeNull();
    expect(overall.totalObtained).toBeNull();
    expect(overall.academicStatus).toBe("promoted");
  });

  test("a failed descriptive subject still decides the academic status", () => {
    const scale = SCALE.map((d) => (d.id === "ni" ? { ...d, notAchieved: true } : d));
    const reading = calculateSubjectResult(readingConfig({ descriptors: scale }), [
      pick("fluent", "ni"),
      pick("letters", "ni"),
      pick("story", "ni"),
    ]);
    const overall = calculateOverallResult(
      [
        {
          subjectId: "reading",
          requirement: "mandatory",
          includeInAverage: false,
          averageWeight: 1,
          exempt: false,
          result: reading,
        },
      ],
      {
        rounding: { decimals: 2, mode: "half_up" },
        maxFailedSubjectsForSupplementary: 1,
        scale: null,
      },
    );
    expect(overall.academicStatus).toBe("supplementary");
  });
});

describe("descriptive validation", () => {
  test("a complete setup has no errors and no weights to check", () => {
    const config = readingConfig();
    expect(hasErrors(validateSubjectConfig(config))).toBe(false);
    expect(summarizeWeights(config).valid).toBe(true);
  });

  test("needs a descriptor scale and at least one skill", () => {
    const codes = validateSubjectConfig(readingConfig({ descriptors: [], assessments: [] })).map(
      (issue) => issue.code,
    );
    expect(codes).toContain("DESCRIPTORS_REQUIRED");
    expect(codes).toContain("NO_SKILLS");
  });

  test("points are all or nothing", () => {
    const partial = SCALE.map((d) => (d.id === "gd" ? { ...d, points: null } : d));
    const codes = validateSubjectConfig(readingConfig({ descriptors: partial })).map((i) => i.code);
    expect(codes).toContain("DESCRIPTOR_POINTS_PARTIAL");
  });

  test('warns when "not achieved" cannot apply', () => {
    const scale = NO_POINTS.map((d) => (d.id === "ni" ? { ...d, notAchieved: true } : d));
    const issues = validateSubjectConfig(readingConfig({ descriptors: scale }));
    expect(issues.find((i) => i.code === "DESCRIPTOR_NOT_ACHIEVED_UNUSED")?.severity).toBe(
      "warning",
    );
    expect(hasErrors(issues)).toBe(false);
  });
});
