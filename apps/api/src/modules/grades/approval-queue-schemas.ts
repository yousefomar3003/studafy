import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

export const pendingItemTypeSchema = z
  .enum(["grade_submission", "grade_revision", "timetable_version"])
  .openapi({
    description:
      "Type of entity awaiting approval. `grade_revision` is a teacher's correction to grades " +
      "that are already published.",
  });

export const gradeSubmissionDiffSchema = z
  .object({
    gradebook_id: uuidSchema,
    gradebook_class_code: z
      .string()
      .openapi({ description: "Class code from the linked gradebook." }),
    student_id: uuidSchema,
    student_name: z.string().openapi({ description: "Display name of the student." }),
    grade_count: z
      .number()
      .int()
      .openapi({ description: "Number of grade records in this submission." }),
    grades: z
      .array(
        z.object({
          label: z.string(),
          score: z.number().nullable(),
          max_score: z.number(),
          weight: z.number(),
        }),
      )
      .openapi({ description: "Individual grade records in the submission." }),
  })
  .openapi("GradeSubmissionDiff");

export type GradeSubmissionDiff = z.infer<typeof gradeSubmissionDiffSchema>;

export const gradeRevisionDiffSchema = z
  .object({
    gradebook_id: uuidSchema,
    gradebook_class_code: z
      .string()
      .openapi({ description: "Class code from the linked gradebook." }),
    grade_submission_id: uuidSchema,
    student_id: uuidSchema,
    student_name: z.string().openapi({ description: "Display name of the student." }),
    reason: z.string().openapi({ description: "The teacher's reason for the correction." }),
    changes: z
      .array(
        z.object({
          grade_id: uuidSchema,
          label: z.string(),
          max_score: z.number(),
          previous_score: z.number().nullable(),
          new_score: z.number().nullable(),
        }),
      )
      .openapi({ description: "Each corrected assessment: published score and proposed score." }),
  })
  .openapi("GradeRevisionDiff");

export type GradeRevisionDiff = z.infer<typeof gradeRevisionDiffSchema>;

export const timetableVersionDiffSchema = z
  .object({
    version_name: z.string().openapi({ description: "Name of the timetable version." }),
    term_name: z.string().openapi({ description: "Academic term name." }),
    slot_count: z.number().int().openapi({ description: "Number of timetable slots." }),
  })
  .openapi("TimetableVersionDiff");

export type TimetableVersionDiff = z.infer<typeof timetableVersionDiffSchema>;

export const approvalQueueItemSchema = z
  .object({
    id: uuidSchema,
    item_type: pendingItemTypeSchema,
    status: z.string(),
    summary: z.string().openapi({ description: "Human-readable summary of the pending item." }),
    requested_by_user_id: uuidSchema.nullable(),
    requested_by_display_name: z.string().nullable().openapi({
      description: "Display name of the user who submitted this item.",
    }),
    requested_at: dateTimeSchema.nullable(),
    decided_at: dateTimeSchema.nullable(),
    diff: z
      .union([gradeSubmissionDiffSchema, gradeRevisionDiffSchema, timetableVersionDiffSchema])
      .openapi({
        description: "Type-specific payload describing what is being approved.",
      }),
  })
  .openapi("ApprovalQueueItem");

export type ApprovalQueueItem = z.infer<typeof approvalQueueItemSchema>;

export const approvalQueueListSchema = z
  .object({
    items: z.array(approvalQueueItemSchema),
    total: z.number().int().openapi({ description: "Total count of pending items." }),
  })
  .openapi("ApprovalQueueList");

export type ApprovalQueueList = z.infer<typeof approvalQueueListSchema>;

export const bulkDecisionEntrySchema = z
  .object({
    item_type: pendingItemTypeSchema,
    id: uuidSchema,
    action: z.enum(["approve", "reject"]),
    rejection_reason: z.string().min(1).nullable().optional().openapi({
      description: "Required when action is 'reject', ignored when 'approve'.",
    }),
  })
  .openapi("BulkDecisionEntry");

export type BulkDecisionEntry = z.infer<typeof bulkDecisionEntrySchema>;

export const bulkDecisionBodySchema = z
  .object({
    items: z.array(bulkDecisionEntrySchema).min(1).max(50).openapi({
      description: "Up to 50 items to approve or reject in a single request.",
    }),
  })
  .openapi("BulkDecisionBody");

export type BulkDecisionBody = z.infer<typeof bulkDecisionBodySchema>;

export const decisionResultSchema = z
  .object({
    item_type: pendingItemTypeSchema,
    id: uuidSchema,
    status: z.enum(["approved", "rejected"]).nullable(),
    error: z.string().nullable().openapi({
      description: "Error message if the decision failed, null on success.",
    }),
  })
  .openapi("DecisionResult");

export type DecisionResult = z.infer<typeof decisionResultSchema>;

export const bulkDecisionResultSchema = z
  .object({
    results: z.array(decisionResultSchema),
    summary: z.object({
      total: z.number().int(),
      succeeded: z.number().int(),
      failed: z.number().int(),
    }),
  })
  .openapi("BulkDecisionResult");

export type BulkDecisionResult = z.infer<typeof bulkDecisionResultSchema>;
