// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  CURRICULUM_TEMPLATES,
  DEFAULT_DIPLOMA_CONFIG,
  MYP_TOTAL_BOUNDARIES,
  buildTemplateTermStructure,
  calculateOverallResult,
  calculateSubjectResult,
  equalTermWeights,
  getCurriculumTemplate,
  hasErrors,
  matchBand,
  roundTo,
  templateScaleBands,
  validateDiplomaConfig,
  validateGradeScale,
  validateSubjectConfig,
} from "./index";

import type {
  CurriculumTemplate,
  EngineDescriptor,
  MarkInput,
  SubjectGradingConfig,
  TemplateCategory,
} from "./index";

/** The school's exam system stands in for an `exam_structure` template: one 100% exam per term. */
const EXAM_STRUCTURE: TemplateCategory[] = [
  {
    key: "final_exam",
    name: { en: "Final exam", ar: "الاختبار النهائي" },
    kind: "final_exam",
    weight: 100,
    aggregation: "weighted_average",
    maxMarks: 100,
  },
];

/** The engine configuration a template gives a subject in a year with `termCount` terms. */
function engineConfig(template: CurriculumTemplate, termCount = 2): SubjectGradingConfig {
  const { subject } = template;
  const categories =
    subject.structure.source === "categories" ? subject.structure.categories : EXAM_STRUCTURE;
  const built = buildTemplateTermStructure(subject.method, categories, termCount, "en");
  const terms = Array.from({ length: termCount }, (_, index) => ({
    termId: `t${index + 1}`,
    name: `Term ${index + 1}`,
    sequence: index + 1,
    weight: built.termWeights.at(index) ?? 0,
  }));
  const descriptors: EngineDescriptor[] = (template.descriptors ?? []).map((item, index) => ({
    id: `d${index}`,
    label: item.label.en,
    points: item.points,
    notAchieved: item.notAchieved,
  }));
  return {
    method: subject.method,
    maxMarks: subject.maxMarks,
    passPercentage: subject.passPercentage,
    finalExamPassPercentage: null,
    rounding: subject.rounding,
    missingPolicy: "incomplete",
    absentPolicy: "incomplete",
    retakePolicy: "none",
    retakeCapPercentage: null,
    scale: templateScaleBands(template, "en"),
    terms,
    categories: built.categories.map((item) => ({
      id: item.key,
      name: item.name,
      kind: item.kind,
      scope: "term",
      weight: item.weight,
      aggregation: item.aggregation,
      dropLowest: 0,
    })),
    assessments: built.assessments.map((item, index) => ({
      id: `a${index}`,
      categoryId: item.categoryKey,
      termId: `t${item.termIndex + 1}`,
      name: item.name,
      maxMarks: item.maxMarks,
      weight: 1,
      mandatory: true,
    })),
    ...(descriptors.length > 0 ? { descriptors } : {}),
  };
}

const graded = (assessmentId: string, score: number): MarkInput => ({
  assessmentId,
  attempt: 1,
  status: "graded",
  score,
});

describe("curriculum templates", () => {
  test("every template has a unique id and names and descriptions in English and Arabic", () => {
    const ids = CURRICULUM_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "national_percentage",
      "igcse_9_1",
      "igcse_a_star_g",
      "a_level",
      "btec",
      "british_key_stages",
      "ib_pyp",
      "ib_myp",
      "ib_dp",
      "american",
      "french",
      "irish_junior_cycle",
      "irish_leaving_certificate",
    ]);
    for (const template of CURRICULUM_TEMPLATES) {
      for (const value of [template.name, template.description]) {
        expect(value.en.trim()).not.toBe("");
        expect(value.ar.trim()).not.toBe("");
      }
      // Arabic text is actually Arabic (or the same brand name in both).
      expect(/[؀-ۿ]/.test(template.description.ar)).toBe(true);
    }
  });

  test.each(CURRICULUM_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s: its scale, descriptors and subject configuration are valid",
    (_id, template) => {
      if (template.scale) {
        for (const locale of ["en", "ar"] as const) {
          expect(validateGradeScale(templateScaleBands(template, locale))).toEqual([]);
        }
      }
      if (template.subject.method === "descriptive") {
        expect(template.descriptors?.length ?? 0).toBeGreaterThanOrEqual(2);
        expect(template.scale).toBeNull();
      } else {
        expect(template.scale).not.toBeNull();
        expect(template.descriptors).toBeNull();
      }
      for (const termCount of [1, 2, 3]) {
        const issues = validateSubjectConfig(
          engineConfig(template, termCount),
          template.subject.credits
            ? {
                averageWeight: template.subject.credits.averageWeight,
                credits: template.subject.credits.credits,
              }
            : undefined,
        );
        expect(issues).toEqual([]);
      }
      // A GPA or points-total result needs points on every band.
      if (template.resultFormat.format === "points_total") {
        expect(template.scale!.bands.every((band) => band.gpaPoints !== null)).toBe(true);
        expect(template.diploma).toBeDefined();
        expect(validateDiplomaConfig(template.diploma!, template.resultFormat.max)).toEqual([]);
      } else {
        expect(template.diploma).toBeUndefined();
      }
      if (template.resultFormat.format === "gpa") {
        expect(template.scale!.bands.every((band) => band.gpaPoints !== null)).toBe(true);
        expect(template.resultFormat.max).toBeLessThanOrEqual(10);
      }
      // The pass mark falls on a band boundary, so "passed" and the band agree.
      if (template.scale) {
        const mins = template.scale.bands.map((band) => band.minPercentage);
        expect(mins).toContain(template.subject.passPercentage);
      }
    },
  );

  test("getCurriculumTemplate finds a template by id and returns null otherwise", () => {
    expect(getCurriculumTemplate("american")?.resultFormat).toEqual({ format: "gpa", max: 4 });
    expect(getCurriculumTemplate("nope")).toBeNull();
  });

  test("terms share the year equally, the last taking the remainder", () => {
    expect(equalTermWeights(0)).toEqual([]);
    expect(equalTermWeights(1)).toEqual([100]);
    expect(equalTermWeights(2)).toEqual([50, 50]);
    expect(equalTermWeights(3)).toEqual([33.33, 33.33, 33.34]);
  });

  test("the term structure has one assessment per category and term, named in the locale", () => {
    const template = getCurriculumTemplate("american")!;
    if (template.subject.structure.source !== "categories") throw new Error("unexpected");
    const built = buildTemplateTermStructure(
      "weighted",
      template.subject.structure.categories,
      2,
      "ar",
    );
    expect(built.termWeights).toEqual([50, 50]);
    expect(built.categories.map((item) => [item.kind, item.weight])).toEqual([
      ["exam", 40],
      ["quiz", 20],
      ["homework", 15],
      ["classwork", 15],
      ["project", 10],
    ]);
    expect(built.assessments).toHaveLength(10);
    expect(built.assessments[0]).toEqual({
      categoryKey: "tests",
      termIndex: 0,
      name: "الاختبارات",
      maxMarks: 40,
      sortOrder: 0,
    });
  });
});

describe("IB MYP", () => {
  const template = getCurriculumTemplate("ib_myp")!;
  const scale = templateScaleBands(template, "en");

  test("criteria A-D are total-points categories out of 8 with no term weights", () => {
    const config = engineConfig(template, 1);
    expect(config.method).toBe("total_points");
    expect(config.maxMarks).toBe(32);
    expect(config.categories.map((item) => [item.name, item.weight, item.aggregation])).toEqual([
      ["Criterion A", null, "total_points"],
      ["Criterion B", null, "total_points"],
      ["Criterion C", null, "total_points"],
      ["Criterion D", null, "total_points"],
    ]);
    expect(config.assessments.map((item) => item.maxMarks)).toEqual([8, 8, 8, 8]);
    expect(config.terms[0]!.weight).toBe(0);
  });

  test("every total out of 32 maps to its MYP grade", () => {
    const expected = (total: number) =>
      MYP_TOTAL_BOUNDARIES.find(([, minTotal]) => total >= minTotal)![0];
    for (let total = 0; total <= 32; total += 1) {
      const percentage = roundTo((total / 32) * 100, template.subject.rounding);
      expect(matchBand(percentage, scale)?.label).toBe(String(expected(total)));
    }
    // The boundaries the programme publishes.
    const grade = (total: number) =>
      matchBand(roundTo((total / 32) * 100, template.subject.rounding), scale)?.label;
    expect([5, 6, 9, 10, 14, 15, 18, 19, 23, 24, 27, 28, 32].map(grade)).toEqual([
      "1",
      "2",
      "2",
      "3",
      "3",
      "4",
      "4",
      "5",
      "5",
      "6",
      "6",
      "7",
      "7",
    ]);
  });

  test("a student's criteria marks give the total, grade and pass", () => {
    const config = engineConfig(template, 1);
    // A 6, B 5, C 4, D 4: 19 of 32, grade 5.
    const result = calculateSubjectResult(config, [
      graded("a0", 6),
      graded("a1", 5),
      graded("a2", 4),
      graded("a3", 4),
    ]);
    expect(result.status).toBe("complete");
    expect(result.marksObtained).toBe(19);
    expect(result.gradeLabel).toBe("5");
    expect(result.gpaPoints).toBe(5);
    expect(result.passed).toBe(true);

    // 9 of 32 is grade 2, below the grade-3 pass.
    const low = calculateSubjectResult(config, [
      graded("a0", 3),
      graded("a1", 2),
      graded("a2", 2),
      graded("a3", 2),
    ]);
    expect(low.gradeLabel).toBe("2");
    expect(low.passed).toBe(false);
  });
});

describe("American", () => {
  const template = getCurriculumTemplate("american")!;

  test("the letter bands and GPA points", () => {
    const scale = templateScaleBands(template, "en");
    const at = (percentage: number) => {
      const band = matchBand(percentage, scale)!;
      return [band.label, band.gpaPoints];
    };
    expect(at(100)).toEqual(["A+", 4]);
    expect(at(96.99)).toEqual(["A", 4]);
    expect(at(90)).toEqual(["A-", 3.7]);
    expect(at(86)).toEqual(["B", 3]);
    expect(at(79.5)).toEqual(["C+", 2.3]);
    expect(at(65)).toEqual(["D", 1]);
    expect(at(64.99)).toEqual(["F", 0]);
  });

  test("subjects are 1 credit, their coefficient; course levels carry the boosts", () => {
    expect(template.subject.credits).toEqual({ credits: 1, averageWeight: 1 });
    expect(template.courseLevels.map((level) => [level.label.en, level.gpaBoost])).toEqual([
      ["Standard", 0],
      ["Honors", 0.5],
      ["AP", 1],
    ]);
  });

  test("an overall GPA out of 4 with an AP boost", () => {
    const config = engineConfig(template, 1);
    const all = (score: (max: number) => number) =>
      config.assessments.map((item) => graded(item.id, score(item.maxMarks)));
    const strong = calculateSubjectResult(
      { ...config, gpaBoost: 1 },
      all((max) => max * 0.95),
    );
    const fair = calculateSubjectResult(
      config,
      all((max) => max * 0.85),
    );
    expect([strong.gradeLabel, fair.gradeLabel]).toEqual(["A", "B"]);
    const overall = calculateOverallResult(
      [
        {
          subjectId: "ap",
          requirement: "mandatory",
          includeInAverage: true,
          averageWeight: 1,
          credits: 1,
          exempt: false,
          result: strong,
        },
        {
          subjectId: "standard",
          requirement: "mandatory",
          includeInAverage: true,
          averageWeight: 1,
          credits: 1,
          exempt: false,
          result: fair,
        },
      ],
      {
        rounding: template.overallRounding,
        maxFailedSubjectsForSupplementary: 0,
        scale: templateScaleBands(template, "en"),
        resultFormat: template.resultFormat,
      },
    );
    expect(overall.display).toEqual({ format: "gpa", value: 3.5, max: 4 });
    expect(overall.weightedGpa).toBe(4);
    expect(overall.creditsEarned).toBe(2);
  });
});

describe("other templates", () => {
  test("French: marks out of 20 and the mentions from 10, 12, 14 and 16", () => {
    const template = getCurriculumTemplate("french")!;
    expect(template.resultFormat).toEqual({ format: "out_of", max: 20 });
    expect(template.subject.maxMarks).toBe(20);
    const scale = templateScaleBands(template, "en");
    const mention = (outOf20: number) => matchBand((outOf20 / 20) * 100, scale)?.label;
    expect([9.99, 10, 12, 14, 16].map(mention)).toEqual([
      "Insuffisant",
      "Passable",
      "Assez bien",
      "Bien",
      "Très bien",
    ]);
    expect(templateScaleBands(template, "ar").map((band) => band.label)[0]).toBe("حسن جدًا");
  });

  test("Irish Junior Cycle and Leaving Certificate boundaries", () => {
    const junior = templateScaleBands(getCurriculumTemplate("irish_junior_cycle")!, "en");
    expect([95, 80, 60, 45, 25, 10].map((p) => matchBand(p, junior)?.label)).toEqual([
      "Distinction",
      "Higher Merit",
      "Merit",
      "Achieved",
      "Partially Achieved",
      "Not Graded",
    ]);
    const leaving = templateScaleBands(getCurriculumTemplate("irish_leaving_certificate")!, "en");
    expect([90, 89.99, 40, 30, 29].map((p) => matchBand(p, leaving)?.label)).toEqual([
      "H1",
      "H2",
      "H6",
      "H7",
      "H8",
    ]);
  });

  test("descriptor templates grade by descriptor, highest first", () => {
    const keyStages = getCurriculumTemplate("british_key_stages")!;
    expect(keyStages.descriptors!.map((item) => item.label.en)).toEqual([
      "Greater depth",
      "Expected standard",
      "Working towards",
    ]);
    const config = engineConfig(keyStages, 1);
    const result = calculateSubjectResult(config, [
      { assessmentId: "a0", attempt: 1, status: "graded", score: null, descriptorId: "d1" },
    ]);
    expect(result.descriptive).toBe(true);
    expect(result.descriptor?.label).toBe("Expected standard");
    expect(getCurriculumTemplate("ib_pyp")!.descriptors).toHaveLength(4);
  });

  test("IB DP and the exam-board templates pass at 40%", () => {
    for (const id of [
      "igcse_9_1",
      "igcse_a_star_g",
      "a_level",
      "btec",
      "ib_dp",
      "irish_junior_cycle",
      "irish_leaving_certificate",
    ]) {
      expect(getCurriculumTemplate(id)!.subject.passPercentage).toBe(40);
    }
    const dp = getCurriculumTemplate("ib_dp")!;
    // The Diploma total out of 45, with the IB matrix and conditions as editable defaults.
    expect(dp.resultFormat).toEqual({ format: "points_total", max: 45 });
    expect(dp.diploma).toEqual(DEFAULT_DIPLOMA_CONFIG);
    expect(hasErrors(validateGradeScale(templateScaleBands(dp, "ar")))).toBe(false);
  });
});
