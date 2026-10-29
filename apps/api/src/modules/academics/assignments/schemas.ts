import { z } from "@hono/zod-openapi";
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  dateTimeSchema,
  uuidSchema,
} from "@studafy/shared-schemas";

/**
 * Request and response schemas for the assignments API (ST-103).
 *
 * Two shape decisions worth stating up front, because both differ from what a reader coming from
 * the ticket would expect:
 *
 * 1. There is no `published` boolean. app.assignments (db/migrations/000011) models lifecycle as a
 *    four-value enum, and its ck_assignments_lifecycle constraint ties `assigned_at` to it. A
 *    boolean layered on top would be a second, weaker source of truth for the same fact.
 * 2. `subject_id` is read-only. A class already resolves to a subject through
 *    classes.course_id -> courses.subject_id, so storing it again on the assignment would let the
 *    two disagree. It is projected onto responses and accepted as a filter; it is never written.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Mirrors the app.assignment_status PostgreSQL enum. */
export const assignmentStatusSchema = z
  .enum(["draft", "published", "closed", "archived"])
  .openapi({ description: "Lifecycle state of an assignment." });

export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

/**
 * The `status` list filter, which is deliberately NOT assignmentStatusSchema.
 *
 * These are the three questions a student's assignment list actually asks -- what is coming up,
 * what did I miss, what have I handed in -- and none of them is a column value. `upcoming` and
 * `past_due` are derived from due_at against the server clock; `submitted` is a join against the
 * caller's own submission rows.
 */
export const assignmentFilterStatusSchema = z.enum(["upcoming", "past_due", "submitted"]).openapi({
  description:
    "Derived status filter. `upcoming` = due in the future, `past_due` = due date has passed, " +
    "`submitted` = the calling student has a submission on record.",
});

export type AssignmentFilterStatus = z.infer<typeof assignmentFilterStatusSchema>;

/**
 * Mirrors the app.assignment_kind PostgreSQL enum (db/migrations/000167). Fixed at creation: what a
 * hand-in consists of cannot change once students may have started one.
 */
export const assignmentKindSchema = z.enum(["written", "questions"]).openapi({
  description:
    "What a hand-in consists of. `written` = free text and file attachments, marked by the " +
    "teacher. `questions` = answers to the assignment's multiple-choice and true/false " +
    "questions, marked automatically and released by the teacher.",
});

export type AssignmentKind = z.infer<typeof assignmentKindSchema>;

/** Mirrors the app.assignment_question_type PostgreSQL enum (db/migrations/000167). */
export const questionTypeSchema = z.enum(["multiple_choice", "true_false"]).openapi({
  description:
    "`multiple_choice` = 2-6 options, one correct. `true_false` = exactly two options, one correct.",
});

export type QuestionType = z.infer<typeof questionTypeSchema>;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const assignmentAttachmentSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    assignment_id: uuidSchema.openapi({ description: "Owning assignment." }),
    original_file_name: z.string().openapi({
      description: "File name as uploaded.",
      example: "week-3-problem-set.pdf",
    }),
    mime_type: z.string().openapi({ description: "Content type.", example: "application/pdf" }),
    size_bytes: z.number().int().openapi({ description: "Object size in bytes." }),
    checksum_sha256: z.string().nullable().openapi({
      description: "Lowercase hex SHA-256 of the object, when the client supplied one.",
    }),
    // The storage key itself is never serialized. It encodes the bucket layout and another
    // school's key is guessable from it, so the pre-signed URL is the only handle a client gets.
    download_url: z
      .string()
      .nullable()
      .openapi({
        description:
          "Short-lived pre-signed GET URL. Null when object storage is not configured for this " +
          "deployment. Never a raw bucket URL -- treat it as opaque and do not cache it beyond " +
          "`download_url_expires_at`.",
      }),
    download_url_expires_at: dateTimeSchema.nullable().openapi({
      description: "When `download_url` stops working.",
    }),
    uploaded_by_user_id: uuidSchema.openapi({ description: "User who confirmed the upload." }),
    created_at: dateTimeSchema,
  })
  .openapi("AssignmentAttachment");

export type AssignmentAttachment = z.infer<typeof assignmentAttachmentSchema>;

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export const assignmentQuestionOptionSchema = z
  .object({
    id: uuidSchema.openapi({
      description: "Primary key. Sent back as `option_id` when answering.",
    }),
    position: z.number().int().openapi({ description: "1-based display order." }),
    text: z.string().openapi({ description: "Option text.", example: "Chloroplast" }),
    // The answer key. Withheld from anyone who is not staff for the assignment: a student learns
    // which option was correct from their own submission, once its mark is released.
    is_correct: z
      .boolean()
      .nullable()
      .openapi({
        description:
          "Whether this is the correct option. Null for students and parents -- they see the " +
          "correct answer on their own submission once its mark is released.",
      }),
  })
  .openapi("AssignmentQuestionOption");

export type AssignmentQuestionOption = z.infer<typeof assignmentQuestionOptionSchema>;

/** The image types a question picture may be; mirrors ck_assignment_questions_image_mime_type. */
export const QUESTION_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const QUESTION_IMAGE_CONTENT_CLASS = "assignment.question_image";

export type QuestionImageContentType = (typeof QUESTION_IMAGE_CONTENT_TYPES)[number];

export const assignmentQuestionImageSchema = z
  .object({
    content_type: z.enum(QUESTION_IMAGE_CONTENT_TYPES),
    size_bytes: z.number().int().positive(),
    // The storage key itself is never serialized; the pre-signed URL is the only handle.
    download_url: z
      .string()
      .nullable()
      .openapi({
        description:
          "Short-lived pre-signed GET URL for the picture. Null when object storage is not " +
          "configured for this deployment. Re-fetch the assignment for a fresh one after " +
          "`download_url_expires_at`.",
      }),
    download_url_expires_at: dateTimeSchema.nullable().openapi({
      description: "When `download_url` stops working.",
    }),
  })
  .openapi("AssignmentQuestionImage");

export type AssignmentQuestionImage = z.infer<typeof assignmentQuestionImageSchema>;

export const assignmentQuestionSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    position: z.number().int().openapi({ description: "1-based display order." }),
    question_type: questionTypeSchema,
    prompt: z.string().openapi({
      description: 'The question. Empty ("") when the picture is the whole question.',
      example: "Where does photosynthesis happen?",
    }),
    // The question's picture; absent when it has none. Optional rather than nullable: the mobile
    // client's generator reads a nullable reference as required and would fail to parse null.
    image: assignmentQuestionImageSchema.optional(),
    points: z.number().openapi({ description: "Points for a correct answer.", example: 2 }),
    options: z.array(assignmentQuestionOptionSchema).openapi({ description: "Options in order." }),
  })
  .openapi("AssignmentQuestion");

export type AssignmentQuestion = z.infer<typeof assignmentQuestionSchema>;

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export const assignmentSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    class_id: uuidSchema.openapi({ description: "Class this assignment belongs to." }),
    subject_id: uuidSchema.openapi({
      description: "Subject, resolved through the class's course. Read-only.",
    }),
    title: z.string().openapi({ description: "Assignment title.", example: "Problem Set 3" }),
    description: z.string().nullable().openapi({ description: "Short summary for listings." }),
    instructions: z.string().nullable().openapi({ description: "Full instructions for students." }),
    status: assignmentStatusSchema,
    kind: assignmentKindSchema,
    available_from: dateTimeSchema
      .nullable()
      .openapi({ description: "When students may begin. Null means immediately on publish." }),
    assigned_at: dateTimeSchema
      .nullable()
      .openapi({ description: "When the assignment left draft. Null while still a draft." }),
    due_at: dateTimeSchema.openapi({ description: "Submission deadline." }),
    max_score: z.number().openapi({ description: "Total points available.", example: 100 }),
    allow_late_submission: z
      .boolean()
      .openapi({ description: "Whether submissions are accepted after due_at." }),
    attachments: z
      .array(assignmentAttachmentSchema)
      .openapi({ description: "Files attached by the teacher, with pre-signed download URLs." }),
    questions: z.array(assignmentQuestionSchema).openapi({
      description: "The questions, in order. Always empty for a `written` assignment.",
    }),
    created_by_user_id: uuidSchema.openapi({ description: "Teacher who created it." }),
    last_edited_by_user_id: uuidSchema.openapi({ description: "Most recent editor." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Assignment");

export type Assignment = z.infer<typeof assignmentSchema>;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Cursor-paginated, following the contract established by the bulk invitations endpoints rather
 * than the limit/offset used elsewhere in academics. Assignment lists are read continuously by
 * students on mobile while teachers are still adding rows; an offset silently skips or repeats
 * items when the underlying set shifts, and a keyset cursor does not.
 *
 * `limit` and `cursor` are declared inline against @hono/zod-openapi's `z` (as bulk-invite-routes
 * does) so the generated document carries the field descriptions, but the bounds come from
 * @studafy/shared-schemas so the 100-item cap stays single-sourced.
 */
export const assignmentListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGINATION_MAX_LIMIT)
      .default(PAGINATION_DEFAULT_LIMIT)
      .openapi({ description: "Maximum assignments to return." }),
    cursor: z.string().min(1).optional().openapi({
      description: "Opaque forward cursor from a previous response's `next_cursor`.",
    }),
    class_id: uuidSchema.optional().openapi({ description: "Restrict to one class." }),
    subject_id: uuidSchema
      .optional()
      .openapi({ description: "Restrict to classes whose course belongs to this subject." }),
    status: assignmentFilterStatusSchema.optional(),
  })
  .openapi("AssignmentListQuery");

export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;

export const assignmentListSchema = z
  .object({
    assignments: z.array(assignmentSchema),
    next_cursor: z.string().nullable().openapi({
      description: "Pass as `cursor` to fetch the next page. Null on the last page.",
    }),
  })
  .openapi("AssignmentList");

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Upper bound on points.
 *
 * max_score is numeric(10, 2) in PostgreSQL, so 99,999,999.99 is the true ceiling. Rejecting
 * anything above 10,000 here instead is a deliberate narrowing: a five-figure score is a typo in
 * every real gradebook, and catching it as a 400 is far kinder than storing it.
 */
const MAX_SCORE_CEILING = 10_000;

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .openapi({ description: "Assignment title.", example: "Problem Set 3" });

const maxScoreSchema = z
  .number()
  .positive()
  .max(MAX_SCORE_CEILING)
  .multipleOf(0.01)
  .openapi({ description: "Total points available. Two decimal places.", example: 100 });

export const createAssignmentBodySchema = z
  .object({
    class_id: uuidSchema.openapi({ description: "Class to assign this to." }),
    title: titleSchema,
    description: z.string().trim().min(1).max(2_000).optional(),
    instructions: z.string().trim().min(1).max(20_000).optional(),
    available_from: dateTimeSchema.optional().openapi({
      description: "When students may begin. Must not be after due_at.",
    }),
    due_at: dateTimeSchema.openapi({ description: "Submission deadline." }),
    max_score: maxScoreSchema,
    allow_late_submission: z.boolean().default(false),
    status: assignmentStatusSchema
      .exclude(["archived"])
      .default("draft")
      .openapi({
        description:
          "Create directly as `published` to skip the draft step. A `questions` assignment must " +
          "be created as a draft: it has no questions yet, and publishing one without any is " +
          "refused.",
      }),
    kind: assignmentKindSchema.default("written").openapi({
      description:
        "Fixed at creation. For `questions`, `max_score` is replaced by the sum of the question " +
        "points whenever the questions are saved.",
    }),
  })
  // Mirrors ck_assignments_availability. Enforcing it here as well as in the database is what turns
  // an inverted date range into a 400 naming the field, rather than a 500 from a CHECK violation
  // whose constraint name means nothing to the caller.
  .refine((body) => !body.available_from || body.available_from <= body.due_at, {
    message: "available_from must not be after due_at",
    path: ["available_from"],
  })
  .openapi("CreateAssignmentBody");

export type CreateAssignmentBody = z.infer<typeof createAssignmentBodySchema>;

export const updateAssignmentBodySchema = z
  .object({
    title: titleSchema.optional(),
    description: z.string().trim().min(1).max(2_000).nullish(),
    instructions: z.string().trim().min(1).max(20_000).nullish(),
    available_from: dateTimeSchema.nullish(),
    due_at: dateTimeSchema.optional(),
    max_score: maxScoreSchema.optional(),
    allow_late_submission: z.boolean().optional(),
    status: assignmentStatusSchema.optional(),
  })
  // A PATCH may set either date, both, or neither, so the pair can only be fully validated against
  // the stored row -- the service re-checks the merged values. This catches the case that is
  // decidable from the body alone.
  .refine((body) => !body.available_from || !body.due_at || body.available_from <= body.due_at, {
    message: "available_from must not be after due_at",
    path: ["available_from"],
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "At least one field must be provided",
  })
  .openapi("UpdateAssignmentBody");

export type UpdateAssignmentBody = z.infer<typeof updateAssignmentBodySchema>;

/** Bounds on a question set: a class quiz of up to twenty questions, each with two to four options. */
export const MAX_QUESTIONS = 20;
export const MAX_OPTIONS = 4;

const questionOptionInputSchema = z
  .object({
    text: z.string().trim().min(1).max(500).openapi({ description: "Option text." }),
    is_correct: z.boolean().openapi({ description: "Exactly one option per question is correct." }),
  })
  .openapi("QuestionOptionInput");

// One object with exactly one of two fields, rather than a union of two: the mobile client's
// generator cannot type a oneOf (see apps/mobile/pubspec.yaml), and the rule is one refine.
const questionImageInputSchema = z
  .object({
    upload_key: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .openapi({
        description:
          "A new picture: the temp/ `storage_key` returned by POST " +
          "/api/storage/uploads/request-upload (content_class `assignment.question_image`), after " +
          "the client has PUT the picture to its `upload_url`. Do NOT call " +
          "/api/storage/uploads/confirm: saving the questions confirms it.",
      }),
    keep_from_question_id: uuidSchema.optional().openapi({
      description:
        "Keep the picture already on this question of the same assignment (its id from the " +
        "current question set). How an unchanged picture survives a save, which replaces every " +
        "question.",
    }),
  })
  .strict()
  .refine(
    (image) => (image.upload_key === undefined) !== (image.keep_from_question_id === undefined),
    { message: "Set exactly one of upload_key and keep_from_question_id" },
  )
  .openapi("QuestionImageInput");

const questionInputSchema = z
  .object({
    question_type: questionTypeSchema,
    prompt: z.string().trim().max(2_000).openapi({
      description: "The question. May be empty when `image` is set: the picture is the question.",
    }),
    // The question's picture: a new upload, a kept one, or none.
    image: questionImageInputSchema.nullable().optional(),
    points: z
      .number()
      .positive()
      .max(MAX_SCORE_CEILING)
      .multipleOf(0.01)
      .openapi({ description: "Points for a correct answer. Two decimal places.", example: 1 }),
    options: z
      .array(questionOptionInputSchema)
      .min(2)
      .max(MAX_OPTIONS)
      .openapi({
        description:
          "In display order. 2-4 for `multiple_choice`, exactly 2 for `true_false`. Exactly one " +
          "must be correct.",
      }),
  })
  .refine((question) => question.question_type !== "true_false" || question.options.length === 2, {
    message: "A true/false question has exactly two options",
    path: ["options"],
  })
  .refine((question) => question.options.filter((option) => option.is_correct).length === 1, {
    message: "Exactly one option must be marked correct",
    path: ["options"],
  })
  .refine((question) => question.prompt.length > 0 || Boolean(question.image), {
    message: "A question needs text or a picture",
    path: ["prompt"],
  })
  .openapi("QuestionInput");

export type QuestionInput = z.infer<typeof questionInputSchema>;

/**
 * Replaces the whole question set. A form editor saves the form, not a diff of it; accepting the
 * complete list makes ordering, removal, and the "exactly one correct" rule one validated write
 * rather than a sequence of partial ones that could each leave the set half-edited.
 */
export const replaceQuestionsBodySchema = z
  .object({
    questions: z
      .array(questionInputSchema)
      .max(MAX_QUESTIONS)
      .openapi({
        description:
          "The complete question set, in order, at most 20. Replaces whatever was there. Refused " +
          "with 409 once any student has handed in answers.",
      }),
  })
  .refine(
    (body) => {
      const images = body.questions.flatMap((question) =>
        question.image
          ? [
              question.image.upload_key !== undefined
                ? `u:${question.image.upload_key}`
                : `k:${question.image.keep_from_question_id}`,
            ]
          : [],
      );
      return new Set(images).size === images.length;
    },
    { path: ["questions"], message: "Each picture can be used by only one question" },
  )
  .openapi("ReplaceQuestionsBody");

export type ReplaceQuestionsBody = z.infer<typeof replaceQuestionsBodySchema>;

// ---------------------------------------------------------------------------
// Attachment upload flow
// ---------------------------------------------------------------------------

export const createUploadUrlBodySchema = z
  .object({
    file_name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      // No path separators: the name becomes the last segment of the storage key, and a `/` in it
      // would silently restructure that key. lib/storage/keys.ts rejects it again at build time.
      .regex(/^[^/\\]+$/, "must not contain a path separator")
      .openapi({ description: "Original file name.", example: "week-3-problem-set.pdf" }),
    content_type: z
      .string()
      .trim()
      .regex(/^[^/\s]+\/[^/\s]+$/, "must be a MIME type")
      .openapi({
        description: "MIME type the client will upload with.",
        example: "application/pdf",
      }),
  })
  .openapi("CreateUploadUrlBody");

export type CreateUploadUrlBody = z.infer<typeof createUploadUrlBodySchema>;

export const uploadUrlSchema = z
  .object({
    upload_url: z.string().openapi({
      description: "Pre-signed PUT URL. Upload the file body directly to it, then confirm.",
    }),
    storage_key: z.string().openapi({
      description:
        "Staging key to pass back to the confirm endpoint. Opaque -- do not construct or edit it.",
    }),
    expires_at: dateTimeSchema.openapi({ description: "When `upload_url` stops working." }),
  })
  .openapi("UploadUrl");

export const confirmAttachmentBodySchema = z
  .object({
    storage_key: z
      .string()
      .min(1)
      .openapi({ description: "The `storage_key` returned by the upload-url endpoint." }),
    content_type: z
      .string()
      .trim()
      .regex(/^[^/\s]+\/[^/\s]+$/, "must be a MIME type")
      .openapi({ description: "MIME type of the uploaded object." }),
    checksum_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "must be lowercase hex SHA-256")
      .optional()
      .openapi({ description: "Optional integrity checksum computed by the client." }),
  })
  .openapi("ConfirmAttachmentBody");

export type ConfirmAttachmentBody = z.infer<typeof confirmAttachmentBodySchema>;

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const assignmentIdParamSchema = z.object({
  assignmentId: uuidSchema.openapi({ param: { name: "assignmentId", in: "path" } }),
});

export const attachmentIdParamSchema = z.object({
  assignmentId: uuidSchema.openapi({ param: { name: "assignmentId", in: "path" } }),
  attachmentId: uuidSchema.openapi({ param: { name: "attachmentId", in: "path" } }),
});
