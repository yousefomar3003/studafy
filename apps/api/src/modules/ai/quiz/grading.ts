import type { QuizQuestionType } from "./schema";

/**
 * Deterministic quiz grading (ST-167).
 *
 * A pure function of the persisted answer key and the submitted answers: same inputs, same score,
 * every time -- no model call, no randomness, no clock. That is the acceptance criterion "grading
 * endpoint scores deterministically". MCQ grading is exact-match against `correctOptionId`.
 * Short-answer grading is normalized-string equality (trim, casefold, collapse internal whitespace):
 * deterministic and honest about its limits, not a semantic judgement -- a synonym or a rephrasing
 * of the right answer is marked wrong. Documented as a known limitation in the schema doc rather than
 * quietly promising more than exact-match delivers.
 *
 * A question with no submitted answer is graded wrong, not skipped, so `results` always covers every
 * question in the quiz and `totalQuestions` never depends on what the student bothered to answer.
 */

export interface GradableQuestion {
  id: string;
  type: QuizQuestionType;
  /** Required and used when `type === "mcq"`; null for `short_answer`. */
  correctOptionId: string | null;
  /** Required and used when `type === "short_answer"`; null for `mcq`. */
  correctAnswer: string | null;
}

export interface QuizAnswerInput {
  questionId: string;
  answer: string;
}

export interface QuizQuestionResult {
  questionId: string;
  correct: boolean;
  /** What the student submitted for this question, or null when they left it unanswered. */
  submittedAnswer: string | null;
  /** The answer key, revealed now that grading has happened: the option id or the short-answer text. */
  correctAnswer: string;
}

export interface QuizGradeResult {
  correctCount: number;
  totalQuestions: number;
  /** Rounded to the nearest whole percent; 0 for a quiz with no questions. */
  percentage: number;
  /** One entry per question in the quiz, in the quiz's question order. */
  results: QuizQuestionResult[];
}

/** Normalize a short-answer submission for exact-match comparison: trim, casefold, collapse whitespace. */
function normalizeShortAnswer(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Grade a quiz. `answers` may omit questions (graded wrong) and, if it names the same `questionId`
 * twice, the later entry in the array wins -- the same "last write wins" rule a client would expect
 * from re-submitting a corrected answer within one request.
 */
export function gradeQuiz(
  questions: readonly GradableQuestion[],
  answers: readonly QuizAnswerInput[],
): QuizGradeResult {
  const submitted = new Map<string, string>();
  for (const answer of answers) {
    submitted.set(answer.questionId, answer.answer);
  }

  const results: QuizQuestionResult[] = questions.map((question) => {
    const answer = submitted.get(question.id) ?? null;

    if (question.type === "mcq") {
      const correctOptionId = question.correctOptionId!;
      return {
        questionId: question.id,
        correct: answer !== null && answer.trim() === correctOptionId,
        submittedAnswer: answer,
        correctAnswer: correctOptionId,
      };
    }

    const correctAnswer = question.correctAnswer!;
    return {
      questionId: question.id,
      correct:
        answer !== null && normalizeShortAnswer(answer) === normalizeShortAnswer(correctAnswer),
      submittedAnswer: answer,
      correctAnswer,
    };
  });

  const correctCount = results.filter((result) => result.correct).length;
  const totalQuestions = questions.length;
  const percentage = totalQuestions === 0 ? 0 : Math.round((correctCount / totalQuestions) * 100);

  return { correctCount, totalQuestions, percentage, results };
}
