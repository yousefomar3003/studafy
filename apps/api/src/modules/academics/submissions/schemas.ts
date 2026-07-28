import { z } from "@hono/zod-openapi";
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  dateTimeSchema,
  uuidSchema,
} from "@studafy/shared-schemas";

/**
 * Request and response schemas for the submissions API (ST-104).
 *
 * Three shape decisions worth stating up front, because all three differ from what a reader coming
 * from the ticket would expect:
 *
 * 1. There is no `is_late` field in any request body. Lateness is not something a client asserts --
 *    it is derived in the database by comparing the hand-in against app.assignments.due_at, so
 *    there is exactly one clock involved. It appears on responses and nowhere else.
 * 2. `grade_status` is a SECOND axis, not a value of `status`. app.assignment_submission_status
 *    already uses 'draft' for "the student has not handed in yet", so overloading it for "the
 *    teacher has not released the mark yet" would make one word mean two opposite things. See
 *    db/migrations/000049.
 * 3. The four grading fields are nullable on the response for a reason that is not "they might be
 *    absent". They are nulled for any non-staff viewer while the grade is unreleased -- the row is
 *    visible, the marks are not. A student cannot tell an unmarked submission from one that is
 *    being marked, which is the point. See toSubmissionResponse in routes/submission-routes.ts.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Mirrors the app.assignment_submission_status PostgreSQL enum (000011).
 *
 * `late` is vestigial. 000011 modelled lateness as a lifecycle state, which made it mutually
 * exclusive with `graded` and therefore erased on marking; 000049 replaced it with the orthogonal
 * `is_late` boolean. The value stays in the enum because rows written before that migration carry
 * it and it cannot be removed from a PostgreSQL enum, but this API never writes it -- a late
 * hand-in is `submitted` with `is_late: true`.
 */
export const submissionStatusSchema = z
  .enum(["draft", "submitted", "late", "graded", "returned", "withdrawn"])
  .openapi({
    description:
      "Lifecycle state of a submission. `late` is a legacy value never written by this API; a " +
      "late hand-in is `submitted` with `is_late: true`.",
  });

export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

/**
 * Mirrors the app.submission_grade_status PostgreSQL enum (000049).
 *
 * Non-staff callers never see `draft`. Reporting it would leak precisely the fact it exists to
 * hide -- that marking has begun -- so the projection reports `none` to them instead.
 */
export const submissionGradeStatusSchema = z.enum(["none", "draft", "published"]).openapi({
  description:
    "Grade release state. `none` = unmarked, `draft` = marked but withheld, `published` = " +
    "released to the student. Students and parents never see `draft`; an unreleased grade " +
    "reports as `none`.",
});

export type SubmissionGradeStatus = z.infer<typeof submissionGradeStatusSchema>;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const submissionAttachmentSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    submission_id: uuidSchema.openapi({ description: "Owning submission." }),
    original_file_name: z.string().openapi({
      description: "File name as uploaded.",
      example: "essay-final.pdf",
    }),
    mime_type: z.string().openapi({ description: "Content type.", example: "application/pdf" }),
    size_bytes: z.number().int().openapi({ description: "Object size in bytes." }),
    checksum_sha256: z.string().nullable().openapi({
      description: "Lowercase hex SHA-256 of the object, when the client supplied one.",
    }),
    attempt_number: z
      .number()
      .int()
      .openapi({
        description:
          "Which attempt this file was uploaded against. Resubmission updates the submission in " +
          "place, so files from a superseded attempt keep their original number.",
      }),
    // The storage key itself is never serialized. It encodes the bucket layout and another
    // school's key is guessable from it, so the pre-signed URL is the only handle a client gets.
    download_url: z
      .string()
      .nullable()
      .openapi({
        description:
          "Short-lived pre-signed GET URL. Null when object storage is not configured for this " +
          "deployment. Treat it as opaque and do not cache it beyond `download_url_expires_at`.",
      }),
    download_url_expires_at: dateTimeSchema.nullable().openapi({
      description: "When `download_url` stops working.",
    }),
    uploaded_by_user_id: uuidSchema.openapi({ description: "User who confirmed the upload." }),
    created_at: dateTimeSchema,
  })
  .openapi("SubmissionAttachment");

export type SubmissionAttachment = z.infer<typeof submissionAttachmentSchema>;

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export const submissionSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    assignment_id: uuidSchema.openapi({ description: "Assignment this answers." }),
    student_id: uuidSchema.openapi({ description: "Student who handed it in." }),
    content: z
      .string()
      .nullable()
      .openapi({ description: "Free-text answer. Null when the hand-in is attachments only." }),
    status: submissionStatusSchema,
    grade_status: submissionGradeStatusSchema,
    is_late: z.boolean().openapi({
      description:
        "Whether the hand-in landed after the assignment's due_at. Computed in the database at " +
        "submission time and unaffected by grading.",
    }),
    attempt_number: z.number().int().openapi({
      description: "1 on first hand-in, incremented on every resubmission.",
    }),
    submitted_at: dateTimeSchema
      .nullable()
      .openapi({ description: "When the current attempt was handed in." }),
    // The four fields below are withheld -- rendered null -- from students and linked parents
    // until grade_status is 'published'. Staff always see the true values.
    score: z
      .number()
      .nullable()
      .openapi({ description: "Points awarded. Null until the grade is released to the caller." }),
    feedback: z
      .string()
      .nullable()
      .openapi({ description: "Teacher's comments. Null until the grade is released." }),
    graded_at: dateTimeSchema.nullable().openapi({ description: "When the mark was recorded." }),
    graded_by_user_id: uuidSchema
      .nullable()
      .openapi({ description: "Teacher who marked it. Null until the grade is released." }),
    attachments: z
      .array(submissionAttachmentSchema)
      .openapi({ description: "Files handed in, with pre-signed download URLs." }),
    last_edited_by_user_id: uuidSchema.openapi({ description: "Most recent editor." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Submission");

export type Submission = z.infer<typeof submissionSchema>;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Limit/offset rather than the keyset cursor the assignments list uses.
 *
 * The difference is the size and shape of the set. An assignment list grows without bound and is
 * read continuously while teachers add rows, which is what makes an offset unsafe there. A
 * submissions list is one assignment's class roster -- bounded, small, and it is a marking queue
 * that a teacher pages through deliberately. That matches every other academics list endpoint, so
 * it uses their contract rather than inventing a third.
 */
export const submissionListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGINATION_MAX_LIMIT)
      .default(PAGINATION_DEFAULT_LIMIT)
      .openapi({ description: "Maximum submissions to return." }),
    offset: z.coerce.number().int().min(0).default(0).openapi({ description: "Records to skip." }),
    status: submissionStatusSchema.optional().openapi({
      description: "Restrict to one lifecycle state.",
    }),
    grade_status: submissionGradeStatusSchema.optional().openapi({
      description:
        "Restrict to one grade release state -- the teacher's marking queue is " +
        "`grade_status=none`. Ignored for non-staff callers, who cannot observe it.",
    }),
    student_id: uuidSchema.optional().openapi({
      description: "Restrict to one student. Staff only; ignored for other callers.",
    }),
  })
  .openapi("SubmissionListQuery");

export type SubmissionListQuery = z.infer<typeof submissionListQuerySchema>;

export const submissionListSchema = z
  .object({
    submissions: z.array(submissionSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("SubmissionList");

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Upper bound on submitted text.
 *
 * content is unbounded `text` in PostgreSQL. 100k characters is roughly a 150-page essay -- far
 * past any real hand-in, and small enough that a runaway client cannot use the column as a blob
 * store. Files go through the attachment flow, which never routes bytes through this API.
 */
const CONTENT_MAX_LENGTH = 100_000;

/**
 * Upper bound on points, matching the assignments module's MAX_SCORE_CEILING.
 *
 * score is numeric(10, 2), so 99,999,999.99 is the true ceiling. The real bound is the
 * assignment's own max_score, which only the database can check -- this is the cheap
 * decidable-from-the-body half, so an obvious typo is a 400 naming the field rather than a
 * round trip.
 */
const SCORE_CEILING = 10_000;

export const createSubmissionBodySchema = z
  .object({
    content: z.string().trim().min(1).max(CONTENT_MAX_LENGTH).optional().openapi({
      description: "Free-text answer. Omit for an attachments-only hand-in.",
      example: "My answer to question 1 is...",
    }),
  })
  .openapi("CreateSubmissionBody");

export type CreateSubmissionBody = z.infer<typeof createSubmissionBodySchema>;

export const gradeSubmissionBodySchema = z
  .object({
    score: z.number().min(0).max(SCORE_CEILING).multipleOf(0.01).optional().openapi({
      description:
        "Points awarded. Two decimal places. Must not exceed the assignment's max_score.",
      example: 87.5,
    }),
    feedback: z.string().trim().min(1).max(10_000).nullish().openapi({
      description: "Comments for the student. Pass null to clear.",
    }),
    publish: z
      .boolean()
      .default(false)
      .openapi({
        description:
          "False saves a draft mark visible only to staff. True releases it to the student and " +
          "their linked parents, and moves the submission to `graded`.",
      }),
    return_to_student: z
      .boolean()
      .default(false)
      .openapi({
        description:
          "Send the work back for another attempt. Mutually exclusive with `publish`; clears the " +
          "draft mark and permits resubmission even after the deadline.",
      }),
  })
  // Publishing without a score would violate ck_assignment_submissions_lifecycle (000049), which
  // requires score IS NOT NULL when grade_status = 'published'. Catching it here turns a CHECK
  // violation whose constraint name means nothing to the caller into a 400 naming the field.
  .refine((body) => !body.publish || body.score !== undefined, {
    message: "score is required when publish is true",
    path: ["score"],
  })
  .refine((body) => !(body.publish && body.return_to_student), {
    message: "publish and return_to_student are mutually exclusive",
    path: ["return_to_student"],
  })
  .refine(
    (body) =>
      body.score !== undefined ||
      body.feedback !== undefined ||
      body.publish ||
      body.return_to_student,
    { message: "At least one field must be provided" },
  )
  .openapi("GradeSubmissionBody");

export type GradeSubmissionBody = z.infer<typeof gradeSubmissionBodySchema>;

// ---------------------------------------------------------------------------
// Attachment upload flow
// ---------------------------------------------------------------------------

export const createSubmissionUploadUrlBodySchema = z
  .object({
    file_name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      // No path separators: the name becomes the last segment of the storage key, and a `/` in it
      // would silently restructure that key. lib/storage/keys.ts rejects it again at build time.
      .regex(/^[^/\\]+$/, "must not contain a path separator")
      .openapi({ description: "Original file name.", example: "essay-final.pdf" }),
    content_type: z
      .string()
      .trim()
      .regex(/^[^/\s]+\/[^/\s]+$/, "must be a MIME type")
      .openapi({
        description: "MIME type the client will upload with.",
        example: "application/pdf",
      }),
  })
  .openapi("CreateSubmissionUploadUrlBody");

export type CreateSubmissionUploadUrlBody = z.infer<typeof createSubmissionUploadUrlBodySchema>;

export const submissionUploadUrlSchema = z
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
  .openapi("SubmissionUploadUrl");

export const confirmSubmissionAttachmentBodySchema = z
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
  .openapi("ConfirmSubmissionAttachmentBody");

export type ConfirmSubmissionAttachmentBody = z.infer<typeof confirmSubmissionAttachmentBodySchema>;

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const assignmentIdParamSchema = z.object({
  assignmentId: uuidSchema.openapi({ param: { name: "assignmentId", in: "path" } }),
});

export const submissionIdParamSchema = z.object({
  submissionId: uuidSchema.openapi({ param: { name: "submissionId", in: "path" } }),
});

export const submissionAttachmentIdParamSchema = z.object({
  submissionId: uuidSchema.openapi({ param: { name: "submissionId", in: "path" } }),
  attachmentId: uuidSchema.openapi({ param: { name: "attachmentId", in: "path" } }),
});
