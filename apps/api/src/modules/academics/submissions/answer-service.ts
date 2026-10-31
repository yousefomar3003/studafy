import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";

import type { AssignmentKind } from "../assignments/schemas";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * A student's answers to a `questions` assignment (db/migrations/000167), and the mark they earn.
 *
 * ## The mark is derived, never stored
 *
 * `auto_score` is the sum of points for the questions whose chosen option is correct, computed on
 * every read from the answers and the answer key. The migration header explains why it is not a
 * column. The teacher releases it through the ordinary grading path (gradeSubmission), so it is
 * withheld from the student by exactly the rule that withholds every other mark -- gradeIsVisible.
 *
 * ## Validation happens before the hand-in is written
 *
 * The answer set is checked against the question set first, so a malformed hand-in is a 400 that
 * leaves any earlier attempt untouched rather than a write that has to be rolled back. The database
 * would also refuse an option from another question (fk_submission_answers_option), but as a 500
 * naming a constraint; this is the half that names the problem.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnswerInput {
  question_id: string;
  option_id: string;
}

export interface AnswerRow {
  submission_id: string;
  question_id: string;
  option_id: string;
  is_correct: boolean;
  correct_option_id: string | null;
  /** numeric(10, 2), so a string from postgres.js. */
  points: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The assignment's kind, or null when the caller cannot see the assignment.
 *
 * Read through RLS with no status predicate: a null is left for the hand-in path to explain (a
 * draft or another class's assignment answers 404 there), so this never becomes an oracle of its
 * own.
 */
export async function getAssignmentKind(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
): Promise<AssignmentKind | null> {
  const [row] = await tx<{ kind: AssignmentKind }[]>`
    SELECT kind FROM app.assignments
    WHERE school_id = ${schoolId} AND id = ${assignmentId}
  `;

  return row?.kind ?? null;
}

/**
 * The ids among `assignmentIds` that are `questions` assignments, in one query.
 *
 * The batch form of getAssignmentKind, for a page of submissions that spans assignments. Read
 * through RLS the same way: an assignment the caller cannot see is simply absent, which projects
 * exactly as getAssignmentKind's null does.
 */
export async function listQuestionAssignmentIds(
  tx: TransactionSql,
  schoolId: string,
  assignmentIds: string[],
): Promise<Set<string>> {
  if (assignmentIds.length === 0) return new Set();

  const rows = await tx<{ id: string }[]>`
    SELECT id FROM app.assignments
    WHERE school_id = ${schoolId}
      AND id = ANY(${assignmentIds}::uuid[])
      AND kind = 'questions'
  `;

  return new Set(rows.map((row) => row.id));
}

/** Load the answers for a page of submissions in one query, with what marking them needs. */
export async function listAnswersBySubmission(
  tx: TransactionSql,
  schoolId: string,
  submissionIds: string[],
): Promise<Map<string, AnswerRow[]>> {
  const bySubmission = new Map<string, AnswerRow[]>();
  if (submissionIds.length === 0) return bySubmission;

  const rows = await tx<AnswerRow[]>`
    SELECT
      a.submission_id, a.question_id, a.option_id,
      o.is_correct,
      (
        SELECT c.id FROM app.assignment_question_options AS c
        WHERE c.school_id = a.school_id AND c.question_id = a.question_id AND c.is_correct
      ) AS correct_option_id,
      q.points
    FROM app.submission_answers AS a
    JOIN app.assignment_questions AS q
      ON q.id = a.question_id AND q.school_id = a.school_id
    JOIN app.assignment_question_options AS o
      ON o.id = a.option_id AND o.school_id = a.school_id
    WHERE a.school_id = ${schoolId}
      AND a.submission_id = ANY(${submissionIds}::uuid[])
    ORDER BY a.submission_id, q.position
  `;

  for (const row of rows) {
    const list = bySubmission.get(row.submission_id) ?? [];
    list.push(row);
    bySubmission.set(row.submission_id, list);
  }

  return bySubmission;
}

/** Points earned by the correct answers. Rounded to the two decimal places scores are kept in. */
export function autoScore(answers: AnswerRow[]): number {
  const total = answers
    .filter((answer) => answer.is_correct)
    .reduce((sum, answer) => sum + Number(answer.points), 0);
  return Math.round(total * 100) / 100;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Refuse a hand-in whose answers do not fit the assignment.
 *
 * - A `written` assignment takes no answers.
 * - A `questions` assignment takes exactly one answer per question, each naming one of that
 *   question's own options. Answering every question is required: an unanswered question would
 *   otherwise score zero without the student ever being told they missed it.
 *
 * `kind === null` (the caller cannot see the assignment) is not judged here; the hand-in itself
 * answers it with the correct 404/403.
 */
export async function assertAnswersFitAssignment(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
  kind: AssignmentKind | null,
  answers: AnswerInput[] | undefined,
): Promise<void> {
  if (kind === null) return;

  const invalid = (message: string): never => {
    throw new CodedHttpException(400, ERROR_CODES.SUBMISSION_INVALID_ANSWERS, message);
  };

  if (kind === "written") {
    if (answers && answers.length > 0) invalid("A written assignment does not take answers");
    return;
  }

  if (!answers || answers.length === 0) invalid("Answer every question before submitting");

  const options = await tx<{ question_id: string; option_id: string }[]>`
    SELECT q.id AS question_id, o.id AS option_id
    FROM app.assignment_questions AS q
    JOIN app.assignment_question_options AS o
      ON o.question_id = q.id AND o.school_id = q.school_id
    WHERE q.school_id = ${schoolId} AND q.assignment_id = ${assignmentId}
  `;

  const optionsByQuestion = new Map<string, Set<string>>();
  for (const row of options) {
    const set = optionsByQuestion.get(row.question_id) ?? new Set<string>();
    set.add(row.option_id);
    optionsByQuestion.set(row.question_id, set);
  }

  const answered = new Set<string>();
  for (const answer of answers!) {
    if (answered.has(answer.question_id)) invalid("Each question can be answered only once");
    answered.add(answer.question_id);

    const questionOptions = optionsByQuestion.get(answer.question_id);
    if (!questionOptions) invalid("An answer names a question that is not in this assignment");
    if (!questionOptions!.has(answer.option_id)) {
      invalid("An answer names an option that does not belong to its question");
    }
  }

  if (answered.size !== optionsByQuestion.size) invalid("Answer every question before submitting");
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Replace a submission's answers with this attempt's.
 *
 * Called in the hand-in's transaction, after the submission row has been written. Resubmission
 * updates that row in place (submitAssignment), so the previous attempt's answers are removed here
 * rather than kept: only the attempt being marked has answers.
 */
export async function replaceAnswers(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
  answers: AnswerInput[],
): Promise<void> {
  await tx`
    DELETE FROM app.submission_answers
    WHERE school_id = ${schoolId} AND submission_id = ${submissionId}
  `;

  if (answers.length === 0) return;

  await tx`
    INSERT INTO app.submission_answers (school_id, submission_id, question_id, option_id)
    SELECT ${schoolId}::uuid, ${submissionId}::uuid, x.question_id, x.option_id
    FROM jsonb_to_recordset(${tx.json(answers as unknown as JSONValue)}::jsonb)
      AS x(question_id uuid, option_id uuid)
  `;
}
