import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import { assertCanManageClass, getAssignmentForUpdate } from "./assignment-service";

import type { AssignmentRow } from "./assignment-service";
import type { QuestionInput, QuestionType } from "./schemas";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * Questions on a `questions` assignment (db/migrations/000167).
 *
 * ## The answer key
 *
 * `is_correct` is readable by everyone who can read the assignment -- a row policy cannot hide one
 * column (see the migration header). It is withheld at the response projection instead, driven by
 * `viewer_is_staff`, which this module computes in SQL with the same helpers the RLS policies call.
 * A student learns the correct option only from their own submission, once its mark is released
 * (apps/api/src/modules/academics/submissions/answer-service.ts).
 *
 * ## Why a save replaces the whole set
 *
 * See replaceQuestionsBodySchema. The consequence here is that a save is delete-then-insert inside
 * the caller's transaction, which is only safe while nobody has answered: an answer pins its
 * question and option ON DELETE RESTRICT, and this module refuses before reaching that constraint.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuestionOptionRow {
  id: string;
  position: number;
  text: string;
  is_correct: boolean;
}

export interface QuestionRow {
  id: string;
  assignment_id: string;
  position: number;
  question_type: QuestionType;
  /** numeric(10, 2), so a string from postgres.js -- see AssignmentRow.max_score. */
  points: string;
  prompt: string;
  /** Whether the caller is an admin or teaches the assignment's class, i.e. may see the key. */
  viewer_is_staff: boolean;
  options: QuestionOptionRow[];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Load the questions for a page of assignments in one query, grouped by assignment and ordered.
 *
 * Options are aggregated per question in the same statement rather than fetched separately: a page
 * of question assignments would otherwise cost a second round trip for data that is never read
 * without its question.
 */
export async function listQuestionsByAssignment(
  tx: TransactionSql,
  schoolId: string,
  assignmentIds: string[],
): Promise<Map<string, QuestionRow[]>> {
  const byAssignment = new Map<string, QuestionRow[]>();
  if (assignmentIds.length === 0) return byAssignment;

  const rows = await tx<QuestionRow[]>`
    SELECT
      q.id, q.assignment_id, q.position, q.question_type, q.points, q.prompt,
      (app.current_user_is_school_admin() OR app.teaches_assignment(q.assignment_id))
        AS viewer_is_staff,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', o.id, 'position', o.position, 'text', o.text, 'is_correct', o.is_correct
            )
            ORDER BY o.position
          )
          FROM app.assignment_question_options AS o
          WHERE o.school_id = q.school_id AND o.question_id = q.id
        ),
        '[]'::jsonb
      ) AS options
    FROM app.assignment_questions AS q
    WHERE q.school_id = ${schoolId}
      AND q.assignment_id = ANY(${assignmentIds}::uuid[])
    ORDER BY q.assignment_id, q.position
  `;

  for (const row of rows) {
    const list = byAssignment.get(row.assignment_id) ?? [];
    list.push(row);
    byAssignment.set(row.assignment_id, list);
  }

  return byAssignment;
}

export async function countQuestions(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM app.assignment_questions
    WHERE school_id = ${schoolId} AND assignment_id = ${assignmentId}
  `;

  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Replace an assignment's questions and set its max_score to their total.
 *
 * Refusals, in order:
 * - 404 / 403 exactly as an assignment edit (load, then assertCanManageClass).
 * - 409 ASSIGNMENT_KIND_MISMATCH for a written assignment, which has no questions to edit.
 * - 409 ASSIGNMENT_QUESTIONS_LOCKED once any student has handed in. Their answers point at these
 *   rows; changing the questions under them would change what they answered.
 * - 409 ASSIGNMENT_QUESTIONS_REQUIRED for an empty set on an assignment students can already see.
 *
 * max_score follows the questions so the mark a teacher publishes is always out of what the
 * questions are actually worth. An empty set on a draft leaves it alone -- there is nothing to sum,
 * and ck_assignments_max_score forbids zero.
 */
export async function replaceQuestions(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  assignmentId: string,
  questions: QuestionInput[],
): Promise<AssignmentRow> {
  const existing = await getAssignmentForUpdate(tx, schoolId, assignmentId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Assignment not found");
  }

  await assertCanManageClass(tx, existing.class_id);

  if (existing.kind !== "questions") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ASSIGNMENT_KIND_MISMATCH,
      "Only a questions assignment has questions",
    );
  }

  const [answered] = await tx<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM app.assignment_submissions
      WHERE school_id = ${schoolId} AND assignment_id = ${assignmentId}
    ) AS exists
  `;
  if (answered?.exists) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ASSIGNMENT_QUESTIONS_LOCKED,
      "Questions cannot be changed after a student has submitted answers",
    );
  }

  if (questions.length === 0 && existing.status !== "draft") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ASSIGNMENT_QUESTIONS_REQUIRED,
      "A published assignment must keep at least one question",
    );
  }

  const previousCount = await countQuestions(tx, schoolId, assignmentId);

  // Options cascade with their question (000167), so one delete clears the set.
  await tx`
    DELETE FROM app.assignment_questions
    WHERE school_id = ${schoolId} AND assignment_id = ${assignmentId}
  `;

  if (questions.length > 0) {
    // Ids are minted here rather than RETURNed so options can be inserted in the same batch shape
    // as their questions, without a round trip per question to learn its id.
    const prepared = questions.map((question, index) => ({
      id: crypto.randomUUID(),
      position: index + 1,
      question,
    }));

    const questionRows = prepared.map(({ id, position, question }) => ({
      id,
      position,
      question_type: question.question_type,
      prompt: question.prompt,
      points: question.points,
    }));

    const optionRows = prepared.flatMap(({ id, question }) =>
      question.options.map((option, optionIndex) => ({
        question_id: id,
        position: optionIndex + 1,
        text: option.text,
        is_correct: option.is_correct,
      })),
    );

    await tx`
      INSERT INTO app.assignment_questions
        (id, school_id, assignment_id, position, question_type, prompt, points)
      SELECT
        x.id, ${schoolId}::uuid, ${assignmentId}::uuid, x.position,
        x.question_type::app.assignment_question_type, x.prompt, x.points
      FROM jsonb_to_recordset(${tx.json(questionRows as JSONValue)}::jsonb)
        AS x(id uuid, position integer, question_type text, prompt text, points numeric)
    `;

    await tx`
      INSERT INTO app.assignment_question_options
        (school_id, question_id, position, text, is_correct)
      SELECT ${schoolId}::uuid, x.question_id, x.position, x.text, x.is_correct
      FROM jsonb_to_recordset(${tx.json(optionRows as JSONValue)}::jsonb)
        AS x(question_id uuid, position integer, text text, is_correct boolean)
    `;
  }

  const totalPoints = questions.reduce((sum, question) => sum + question.points, 0);

  // Rounded to the column's two decimal places: summing binary floats can land a hair off.
  await tx`
    UPDATE app.assignments
    SET max_score = CASE WHEN ${totalPoints}::numeric > 0
                         THEN round(${totalPoints}::numeric, 2)
                         ELSE max_score END,
        last_edited_by_user_id = ${userId},
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId} AND id = ${assignmentId}
  `;

  const updated = (await getAssignmentForUpdate(tx, schoolId, assignmentId))!;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "assignment_questions",
    targetId: assignmentId,
    oldValues: { question_count: previousCount, max_score: existing.max_score },
    newValues: { question_count: questions.length, max_score: updated.max_score },
  });

  return updated;
}
