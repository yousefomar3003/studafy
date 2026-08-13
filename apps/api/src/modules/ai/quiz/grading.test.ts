// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { gradeQuiz } from "./grading";

import type { GradableQuestion } from "./grading";

const questions: GradableQuestion[] = [
  { id: "q1", type: "mcq", correctOptionId: "A", correctAnswer: null },
  { id: "q2", type: "short_answer", correctOptionId: null, correctAnswer: "Photosynthesis" },
];

describe("gradeQuiz", () => {
  test("scores a fully correct submission", () => {
    const result = gradeQuiz(questions, [
      { questionId: "q1", answer: "A" },
      { questionId: "q2", answer: "Photosynthesis" },
    ]);

    expect(result.correctCount).toBe(2);
    expect(result.totalQuestions).toBe(2);
    expect(result.percentage).toBe(100);
    expect(result.results).toEqual([
      { questionId: "q1", correct: true, submittedAnswer: "A", correctAnswer: "A" },
      {
        questionId: "q2",
        correct: true,
        submittedAnswer: "Photosynthesis",
        correctAnswer: "Photosynthesis",
      },
    ]);
  });

  test("scores a fully wrong submission", () => {
    const result = gradeQuiz(questions, [
      { questionId: "q1", answer: "B" },
      { questionId: "q2", answer: "Respiration" },
    ]);

    expect(result.correctCount).toBe(0);
    expect(result.percentage).toBe(0);
    expect(result.results.every((r) => !r.correct)).toBe(true);
  });

  test("grades an unanswered question as wrong, not skipped", () => {
    const result = gradeQuiz(questions, [{ questionId: "q1", answer: "A" }]);

    expect(result.totalQuestions).toBe(2);
    expect(result.correctCount).toBe(1);
    expect(result.percentage).toBe(50);
    const q2 = result.results.find((r) => r.questionId === "q2")!;
    expect(q2.correct).toBe(false);
    expect(q2.submittedAnswer).toBeNull();
    expect(q2.correctAnswer).toBe("Photosynthesis");
  });

  test("short-answer grading normalizes case and whitespace, not semantics", () => {
    const exact = gradeQuiz(questions, [{ questionId: "q2", answer: "  PHOTOsynthesis  " }]);
    expect(exact.results[1]!.correct).toBe(true);

    const collapsedWhitespace = gradeQuiz(questions, [
      { questionId: "q2", answer: "Photo   synthesis" },
    ]);
    expect(collapsedWhitespace.results[1]!.correct).toBe(false);

    const synonym = gradeQuiz(questions, [{ questionId: "q2", answer: "carbon fixation" }]);
    expect(synonym.results[1]!.correct).toBe(false);
  });

  test("mcq grading is exact-match on the option id, not case-insensitive", () => {
    const result = gradeQuiz(questions, [{ questionId: "q1", answer: "a" }]);
    expect(result.results[0]!.correct).toBe(false);
  });

  test("a duplicate submission for the same question uses the later answer", () => {
    const result = gradeQuiz(questions, [
      { questionId: "q1", answer: "B" },
      { questionId: "q1", answer: "A" },
    ]);
    expect(result.results[0]!.correct).toBe(true);
    expect(result.results[0]!.submittedAnswer).toBe("A");
  });

  test("is deterministic: identical inputs always produce identical output", () => {
    const answers = [
      { questionId: "q1", answer: "A" },
      { questionId: "q2", answer: "Photosynthesis" },
    ];
    expect(gradeQuiz(questions, answers)).toEqual(gradeQuiz(questions, answers));
  });

  test("an empty question list grades as 0 percent, not NaN", () => {
    const result = gradeQuiz([], []);
    expect(result.percentage).toBe(0);
    expect(result.totalQuestions).toBe(0);
    expect(result.results).toEqual([]);
  });
});
