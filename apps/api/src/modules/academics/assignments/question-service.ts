import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { buildPermanentKey, requireStorage } from "../../../lib/storage";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { getContentClass } from "../../storage/content-classes";
import { inspectStagedUpload } from "../../storage/service";
import {
  copyStagedUploads,
  discardStagedUploads,
  reserveStorage,
} from "../../storage/staged-promotion";

import { assertCanManageClass, getAssignmentForUpdate } from "./assignment-service";
import { QUESTION_IMAGE_CONTENT_CLASS } from "./schemas";

import type { AssignmentRow } from "./assignment-service";
import type { QuestionImageContentType, QuestionInput, QuestionType } from "./schemas";
import type { TxRunner } from "../../../db/tenant-tx";
import type { StorageService } from "../../../lib/storage";
import type { InspectedStagedUpload } from "../../storage/service";
import type { StagedCopy } from "../../storage/staged-promotion";
import type { UploadScanStatus } from "@studafy/constants";
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
 *
 * ## Pictures (000169)
 *
 * Because every save mints new question rows, a picture that should survive the save is named by
 * the id of the question that carries it now (`keep_from_question_id`); a new one arrives as a
 * staged temp/ key (`upload_key`), checked and promoted inside the save like a message image. A
 * picture that is dropped or replaced is left in the bucket unreferenced, for the storage
 * reconciliation to reclaim -- never a row pointing at a missing object.
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
  /** All three set, or all null (ck_assignment_questions_image). Never serialized. */
  image_storage_key: string | null;
  image_mime_type: QuestionImageContentType | null;
  /** bigint, which postgres.js hands back as a string. */
  image_size_bytes: string | null;
  /** The picture's malware scan state (000192); a URL is minted only for a servable one. */
  image_scan_status: UploadScanStatus;
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
      q.image_storage_key, q.image_mime_type, q.image_size_bytes::text AS image_size_bytes,
      q.image_scan_status::text AS image_scan_status,
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
  /**
   * Every staged picture of the save, already copied to permanent/ and charged to the meter by
   * saveQuestions. A save with staged pictures goes through saveQuestions; this is its write step.
   */
  promoted: ReadonlyMap<string, PromotedQuestionImage> = new Map(),
): Promise<AssignmentRow> {
  const { existing, images } = await checkReplaceQuestions(
    tx,
    schoolId,
    assignmentId,
    questions,
    promoted,
  );
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

    const questionRows: Record<string, JSONValue>[] = [];
    for (const [index, { id, position, question }] of prepared.entries()) {
      const image = storedImage(images.at(index) ?? null);
      questionRows.push({
        id,
        position,
        question_type: question.question_type,
        prompt: question.prompt,
        points: question.points,
        image_storage_key: image?.storage_key ?? null,
        image_mime_type: image?.mime_type ?? null,
        image_size_bytes: image?.size_bytes ?? null,
        image_scan_status: image?.scan_status ?? "unscanned",
      });
    }

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
        (id, school_id, assignment_id, position, question_type, prompt, points,
         image_storage_key, image_mime_type, image_size_bytes, image_scan_status)
      SELECT
        x.id, ${schoolId}::uuid, ${assignmentId}::uuid, x.position,
        x.question_type::app.assignment_question_type, x.prompt, x.points,
        x.image_storage_key, x.image_mime_type, x.image_size_bytes,
        x.image_scan_status::app.upload_scan_status
      FROM jsonb_to_recordset(${tx.json(questionRows)}::jsonb)
        AS x(id uuid, position integer, question_type text, prompt text, points numeric,
             image_storage_key text, image_mime_type text, image_size_bytes bigint,
             image_scan_status text)
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

/**
 * Every refusal of a save, before anything is written (see replaceQuestions), and every question's
 * picture resolved. saveQuestions runs it in its check transaction, ahead of copying staged
 * pictures, so a refused save copies nothing; replaceQuestions runs it again in the write.
 */
async function checkReplaceQuestions(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
  questions: QuestionInput[],
  promoted: ReadonlyMap<string, PromotedQuestionImage>,
) {
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

  const images = await resolveImages(tx, schoolId, assignmentId, questions, promoted);
  return { existing, images };
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** A picture already stored on this assignment, carried over unchanged. */
interface KeptImage {
  kind: "kept";
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  scan_status: UploadScanStatus;
}

/** A staged picture of a save, already copied to permanent/ and charged by saveQuestions. */
export interface PromotedQuestionImage {
  permanentKey: string;
  upload: InspectedStagedUpload;
}

/** A staged upload that passed every confirm-time check and was promoted for the save. */
interface StagedImage {
  kind: "staged";
  permanentKey: string;
  upload: InspectedStagedUpload;
}

/**
 * Work out every question's picture before anything is written, in question order: kept pictures
 * must name a question of this assignment that has one, and every staged upload must be one
 * saveQuestions inspected and promoted. One bad picture refuses the whole save.
 */
async function resolveImages(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
  questions: QuestionInput[],
  promoted: ReadonlyMap<string, PromotedQuestionImage>,
): Promise<(KeptImage | StagedImage | null)[]> {
  const current = await tx<
    {
      id: string;
      image_storage_key: string;
      image_mime_type: string;
      image_size_bytes: string;
      image_scan_status: UploadScanStatus;
    }[]
  >`
    SELECT id, image_storage_key, image_mime_type, image_size_bytes::text AS image_size_bytes,
           image_scan_status::text AS image_scan_status
    FROM app.assignment_questions
    WHERE school_id = ${schoolId}
      AND assignment_id = ${assignmentId}
      AND image_storage_key IS NOT NULL
  `;
  const currentById = new Map(current.map((row) => [row.id, row]));

  const resolved: (KeptImage | StagedImage | null)[] = [];
  for (const question of questions) {
    const image = question.image;
    if (!image) {
      resolved.push(null);
    } else if (image.keep_from_question_id !== undefined) {
      const kept = currentById.get(image.keep_from_question_id);
      if (!kept) {
        throw new CodedHttpException(
          400,
          ERROR_CODES.VALIDATION_FAILED,
          "keep_from_question_id must name a question of this assignment that has a picture",
        );
      }
      resolved.push({
        kind: "kept",
        storage_key: kept.image_storage_key,
        mime_type: kept.image_mime_type,
        size_bytes: Number(kept.image_size_bytes),
        scan_status: kept.image_scan_status,
      });
    } else {
      // The schema guarantees exactly one of the two fields is set.
      const staged = promoted.get(image.upload_key!);
      if (!staged) {
        // Only reachable by calling replaceQuestions directly with a staged picture.
        throw new Error("A staged picture must be promoted through saveQuestions");
      }
      resolved.push({ kind: "staged", ...staged });
    }
  }
  return resolved;
}

/** The stored columns for a resolved picture. A new picture waits for its malware scan (F-14). */
function storedImage(image: KeptImage | StagedImage | null): {
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  scan_status: UploadScanStatus;
} | null {
  if (!image) return null;
  if (image.kind === "kept") {
    return {
      storage_key: image.storage_key,
      mime_type: image.mime_type,
      size_bytes: image.size_bytes,
      scan_status: image.scan_status,
    };
  }
  return {
    storage_key: image.permanentKey,
    mime_type: image.upload.contentType,
    size_bytes: image.upload.sizeBytes,
    scan_status: "scanning",
  };
}

/**
 * Save an assignment's questions, promoting any newly staged pictures, with no transaction held
 * across object storage (../../storage/staged-promotion.ts): every staged picture is inspected
 * (content class, stored size and type) with no transaction open; one short transaction runs every
 * refusal of the save and charges the pictures to the school's quota; the pictures are copied to
 * permanent/; the write transaction replaces the questions and runs `finish` (the caller's
 * read-back); the staged copies are dropped once it has committed. A save without new pictures is
 * one transaction, as before.
 */
export async function saveQuestions<T>(
  runTx: TxRunner,
  storage: StorageService | null,
  schoolId: string,
  userId: string,
  assignmentId: string,
  questions: QuestionInput[],
  /**
   * Receives the permanent key of every picture this save uploaded, for the caller to hand to the
   * malware scanner once the transaction commits (F-14). Kept pictures keep their scan state.
   */
  uploadedImageKeys: string[],
  finish: (tx: TransactionSql, row: AssignmentRow) => Promise<T>,
): Promise<T> {
  const stagedKeys = [
    ...new Set(questions.flatMap((question) => question.image?.upload_key ?? [])),
  ];
  const write = (promoted: ReadonlyMap<string, PromotedQuestionImage>) =>
    runTx(async (tx) =>
      finish(tx, await replaceQuestions(tx, schoolId, userId, assignmentId, questions, promoted)),
    );
  if (stagedKeys.length === 0) return write(new Map());

  const store = requireStorage(storage);
  const contentClass = getContentClass(QUESTION_IMAGE_CONTENT_CLASS);
  const promoted = new Map<string, PromotedQuestionImage>();
  for (const tempKey of stagedKeys) {
    const upload = await inspectStagedUpload(store, schoolId, contentClass, {
      storageKey: tempKey,
    });
    promoted.set(tempKey, {
      permanentKey: buildPermanentKey(schoolId, upload.parsed.objectId, upload.parsed.filename),
      upload,
    });
  }
  const copies: StagedCopy[] = [...promoted].map(([tempKey, { permanentKey, upload }]) => ({
    tempKey,
    permanentKey,
    sizeBytes: upload.sizeBytes,
  }));

  await runTx(async (tx) => {
    await checkReplaceQuestions(tx, schoolId, assignmentId, questions, promoted);
    await reserveStorage(
      tx,
      copies.reduce((total, copy) => total + copy.sizeBytes, 0),
    );
  });
  await copyStagedUploads(store, runTx, copies);

  const result = await write(promoted);
  uploadedImageKeys.push(...copies.map((copy) => copy.permanentKey));
  await discardStagedUploads(store, copies);
  return result;
}
