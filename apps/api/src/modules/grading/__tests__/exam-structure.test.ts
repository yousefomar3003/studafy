// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { updateSchoolSettingsBodySchema } from "../../tenancy/settings/schemas";
import { buildExamTemplate, DEFAULT_EXAM_WEIGHTS, examWeightsProblem } from "../exam-structure";

describe("examWeightsProblem", () => {
  test("accepts each system's defaults", () => {
    expect(examWeightsProblem("midterm", DEFAULT_EXAM_WEIGHTS.midterm)).toBeNull();
    expect(examWeightsProblem("periods", DEFAULT_EXAM_WEIGHTS.periods)).toBeNull();
  });

  test("needs every part of the system, nothing else, totalling 100", () => {
    expect(examWeightsProblem("midterm", { midterm: 50, final_exam: 50, quiz: 0 })).toBe(
      "Give homework a weight between 0 and 100",
    );
    expect(
      examWeightsProblem("midterm", { ...DEFAULT_EXAM_WEIGHTS.midterm, first_period: 0 }),
    ).toBe("first_period is not part of the midterm system");
    expect(
      examWeightsProblem("periods", {
        first_period: 20,
        second_period: 20,
        final_exam: 20,
        quiz: 20,
        homework: 10,
      }),
    ).toBe("The weights total 90%; they must total 100%");
  });
});

describe("buildExamTemplate", () => {
  test("midterm system: midterm, final, quizzes and homework in every term", () => {
    const template = buildExamTemplate("midterm", DEFAULT_EXAM_WEIGHTS.midterm, ["t1", "t2"], "en");
    expect(template.term_weights).toEqual([
      { term_id: "t1", weight: 50 },
      { term_id: "t2", weight: 50 },
    ]);
    expect(template.categories.map((c) => [c.kind, c.name, c.weight, c.scope])).toEqual([
      ["midterm", "Midterm exam", 30, "term"],
      ["final_exam", "Final exam", 40, "term"],
      ["quiz", "Quizzes", 15, "term"],
      ["homework", "Homework", 15, "term"],
    ]);
    // One assessment per part per term, marked out of the part's share.
    expect(template.assessments.map((a) => [a.term_id, a.category_ref, a.max_marks])).toEqual([
      ["t1", "midterm", 30],
      ["t1", "final_exam", 40],
      ["t1", "quiz", 15],
      ["t1", "homework", 15],
      ["t2", "midterm", 30],
      ["t2", "final_exam", 40],
      ["t2", "quiz", 15],
      ["t2", "homework", 15],
    ]);
  });

  test("periods system in Arabic, leaving out a part set to 0", () => {
    const template = buildExamTemplate(
      "periods",
      { first_period: 25, second_period: 25, final_exam: 40, quiz: 10, homework: 0 },
      ["t1", "t2", "t3"],
      "ar",
    );
    expect(template.categories.map((c) => [c.kind, c.name])).toEqual([
      ["first_period", "اختبار الفترة الأولى"],
      ["second_period", "اختبار الفترة الثانية"],
      ["final_exam", "الاختبار النهائي"],
      ["quiz", "الاختبارات القصيرة"],
    ]);
    expect(template.assessments).toHaveLength(12);
    // Three terms: the last one takes the rounding remainder.
    expect(template.term_weights.map((t) => t.weight)).toEqual([33.33, 33.33, 33.34]);
  });
});

describe("school settings body", () => {
  test("takes the exam system and its weights together, validated against each other", () => {
    expect(
      updateSchoolSettingsBodySchema.safeParse({
        exam_structure: "periods",
        exam_weights: DEFAULT_EXAM_WEIGHTS.periods,
      }).success,
    ).toBe(true);
    expect(updateSchoolSettingsBodySchema.safeParse({ exam_structure: "periods" }).success).toBe(
      false,
    );
    expect(
      updateSchoolSettingsBodySchema.safeParse({
        exam_structure: "periods",
        exam_weights: DEFAULT_EXAM_WEIGHTS.midterm,
      }).success,
    ).toBe(false);
  });
});
