// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  draftFromConfig,
  draftToBody,
  emptyDraft,
  newAssessment,
  newCategory,
  validateDraft,
} from "./config-form";

import type { SubjectConfig } from "./queries";

const TERMS = [
  { id: "term-1", name: "Term 1", sequence_number: 1 },
  { id: "term-2", name: "Term 2", sequence_number: 2 },
  { id: "term-3", name: "Term 3", sequence_number: 3 },
];

describe("config-form", () => {
  test("a new subject starts with its terms weighted to exactly 100", () => {
    const draft = emptyDraft(TERMS);
    expect(draft.termWeights).toEqual({ "term-1": "33.33", "term-2": "33.33", "term-3": "33.34" });
    expect(validateDraft(draft, TERMS).summary.annualTotal).toBeCloseTo(100, 6);
  });

  test("new rows are sent with client refs and existing ones by id", () => {
    const config = {
      section_id: null,
      term_weights: [{ term_id: "term-1", weight: 100 }],
      categories: [
        {
          id: "cat-1",
          name: "Exams",
          kind: "exam",
          scope: "term",
          weight: 100,
          aggregation: "weighted_average",
          drop_lowest: 0,
          sort_order: 0,
        },
      ],
      assessments: [
        {
          id: "asm-1",
          category_id: "cat-1",
          term_id: "term-1",
          section_id: null,
          name: "Exam",
          max_marks: 50,
          weight: 1,
          is_mandatory: true,
          assessment_date: null,
          due_date: null,
          status: "active",
          sort_order: 0,
          mark_count: 3,
        },
        // Added by one section on its own: not part of the grade default's edit.
        {
          id: "asm-sec",
          category_id: "cat-1",
          term_id: "term-1",
          section_id: "sec-1",
          name: "Extra",
          max_marks: 10,
          weight: 1,
          is_mandatory: false,
          assessment_date: null,
          due_date: null,
          status: "active",
          sort_order: 1,
          mark_count: 0,
        },
      ],
      requirement: "mandatory",
      include_in_average: true,
      include_on_certificate: true,
      average_weight: 1,
      grading_method: "weighted",
      max_marks: 100,
      pass_percentage: 50,
      final_exam_pass_percentage: null,
      grade_scale_id: null,
      rounding_decimals: 2,
      rounding_mode: "half_up",
      missing_mark_policy: "incomplete",
      absent_policy: "incomplete",
      retake_policy: "none",
      retake_cap_percentage: null,
      teachers_can_add_assessments: false,
      teacher_assessments_require_approval: true,
      instructions: null,
    } as unknown as SubjectConfig;

    const draft = draftFromConfig(config);
    expect(draft.assessments.map((a) => a.id)).toEqual(["asm-1"]);

    const quizzes = { ...newCategory(), name: "Quizzes", weight: "20" };
    draft.categories = [{ ...draft.categories[0]!, weight: "80" }, quizzes];
    draft.assessments = [
      ...draft.assessments,
      { ...newAssessment(quizzes, "term-1"), name: "Quiz 1" },
    ];

    const body = draftToBody(draft);
    expect(body.categories.map((c) => c.ref)).toEqual(["cat-1", quizzes.key]);
    expect(body.assessments.map((a) => [a.id, a.category_ref])).toEqual([
      ["asm-1", "cat-1"],
      [undefined, quizzes.key],
    ]);
    expect(validateDraft(draft, TERMS.slice(0, 1)).summary).toEqual({
      termCategoryTotal: 100,
      annualTotal: 100,
      valid: true,
    });
  });
});
