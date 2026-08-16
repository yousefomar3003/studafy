/**
 * Deterministic exam grading (ST-171).
 *
 * Same algorithm as `quiz/grading.ts`'s `gradeQuiz` -- a pure function of the persisted answer key
 * and the submitted answers, MCQ by exact option-id match, short-answer by normalized-string
 * equality, unanswered graded wrong rather than skipped, last write wins on a duplicate item id --
 * reimplemented with exam-appropriate naming (`item`, not `question`) rather than imported, since an
 * exam item and a quiz question are the same shape by coincidence, not by a real domain
 * relationship; see docs/rag/exam-mode.md.
 *
 * Unlike quiz grading (an unpersisted, repeatable pure function), this module's result is what
 * `exam/persistence.ts`'s `submitExamSession` writes to `app.exam_item_answers` -- an exam is a
 * one-shot timed submission, not something re-graded on demand.
 */

export const EXAM_ITEM_TYPES = ["mcq", "short_answer"] as const;
export type ExamItemType = (typeof EXAM_ITEM_TYPES)[number];

export interface GradableExamItem {
  id: string;
  type: ExamItemType;
  /** Required and used when `type === "mcq"`; null for `short_answer`. */
  correctOptionId: string | null;
  /** Required and used when `type === "short_answer"`; null for `mcq`. */
  correctAnswer: string | null;
}

export interface ExamAnswerInput {
  itemId: string;
  answer: string;
}

export interface ExamItemResult {
  itemId: string;
  correct: boolean;
  /** What the student submitted for this item, or null when they left it unanswered. */
  submittedAnswer: string | null;
  /** The answer key, revealed now that grading has happened: the option id or the short-answer text. */
  correctAnswer: string;
}

export interface ExamGradeResult {
  correctCount: number;
  totalItems: number;
  /** Rounded to the nearest whole percent; 0 for an exam with no items. */
  percentage: number;
  /** One entry per item in the exam, in the exam's item order. */
  results: ExamItemResult[];
}

/** Normalize a short-answer submission for exact-match comparison: trim, casefold, collapse whitespace. */
function normalizeShortAnswer(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Grade an exam. `answers` may omit items (graded wrong) and, if it names the same `itemId` twice,
 * the later entry in the array wins.
 */
export function gradeExam(
  items: readonly GradableExamItem[],
  answers: readonly ExamAnswerInput[],
): ExamGradeResult {
  const submitted = new Map<string, string>();
  for (const answer of answers) {
    submitted.set(answer.itemId, answer.answer);
  }

  const results: ExamItemResult[] = items.map((item) => {
    const answer = submitted.get(item.id) ?? null;

    if (item.type === "mcq") {
      const correctOptionId = item.correctOptionId!;
      return {
        itemId: item.id,
        correct: answer !== null && answer.trim() === correctOptionId,
        submittedAnswer: answer,
        correctAnswer: correctOptionId,
      };
    }

    const correctAnswer = item.correctAnswer!;
    return {
      itemId: item.id,
      correct:
        answer !== null && normalizeShortAnswer(answer) === normalizeShortAnswer(correctAnswer),
      submittedAnswer: answer,
      correctAnswer,
    };
  });

  const correctCount = results.filter((result) => result.correct).length;
  const totalItems = items.length;
  const percentage = totalItems === 0 ? 0 : Math.round((correctCount / totalItems) * 100);

  return { correctCount, totalItems, percentage, results };
}
