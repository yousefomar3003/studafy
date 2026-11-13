import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { sanitizedTextSchema } from "../../lib/sanitize";

import { blockStateSchema, MESSAGE_ATTACHMENT_CONTENT_TYPES } from "./schemas";

/** Mirrors ck_message_reports_reason_category (000136). */
export const MESSAGE_REPORT_REASONS = [
  "harassment",
  "inappropriate",
  "spam",
  "safety_concern",
  "other",
] as const;
export type MessageReportReason = (typeof MESSAGE_REPORT_REASONS)[number];

/** Mirrors ck_message_reports_status (000136). */
export const MESSAGE_REPORT_STATUSES = ["pending", "in_review", "actioned", "dismissed"] as const;
export type MessageReportStatus = (typeof MESSAGE_REPORT_STATUSES)[number];

export const MESSAGE_REPORT_PRIORITIES = ["urgent", "high", "normal"] as const;
export type MessageReportPriority = (typeof MESSAGE_REPORT_PRIORITIES)[number];

/** Mirrors ck_message_reports_details / ck_message_reports_resolution_note (000136). */
export const MESSAGE_REPORT_DETAILS_MAX_LENGTH = 1000;
export const MESSAGE_REPORT_RESOLUTION_NOTE_MAX_LENGTH = 2000;

export const DEFAULT_MESSAGE_REPORT_PAGE_SIZE = 50;
export const MAX_MESSAGE_REPORT_PAGE_SIZE = 100;

const participantRoleSchema = z.enum(["parent", "teacher"]);

const reportPartySchema = z
  .object({
    id: uuidSchema.openapi({ description: "User id." }),
    name: z.string(),
    role: participantRoleSchema.openapi({ description: "Their side of the thread." }),
  })
  .openapi("MessageReportParty");

// ---------------------------------------------------------------------------
// Filing (participant)
// ---------------------------------------------------------------------------

export const createMessageReportBodySchema = z
  .object({
    message_id: uuidSchema.optional().openapi({
      description:
        "Report one message of this thread. Omit to report the other participant in general.",
    }),
    reason_category: z.enum(MESSAGE_REPORT_REASONS).openapi({
      description:
        "safety_concern is urgent (24h response target); harassment and inappropriate are high " +
        "(48h); spam and other are normal (120h).",
    }),
    details: sanitizedTextSchema({ min: 1, max: MESSAGE_REPORT_DETAILS_MAX_LENGTH })
      .optional()
      .openapi({ description: "Optional free text, 1-1000 characters." }),
    also_block: z.boolean().optional().openapi({
      description: "Also block the other participant in the same call (default false).",
    }),
  })
  .openapi("CreateMessageReportBody");

export const messageReportReceiptSchema = z
  .object({
    id: uuidSchema,
    conversation_id: uuidSchema,
    message_id: uuidSchema.nullable(),
    reason_category: z.enum(MESSAGE_REPORT_REASONS),
    details: z.string().nullable(),
    status: z.enum(MESSAGE_REPORT_STATUSES),
    priority: z.enum(MESSAGE_REPORT_PRIORITIES),
    respond_by: dateTimeSchema,
    created_at: dateTimeSchema,
  })
  .openapi("MessageReportReceipt");

export const createMessageReportResponseSchema = z
  .object({
    report: messageReportReceiptSchema,
    block: blockStateSchema.openapi({
      description: "Block state after the call (reflects `also_block`).",
    }),
  })
  .openapi("CreateMessageReportResponse");

// ---------------------------------------------------------------------------
// Review queue (messageReport:review)
// ---------------------------------------------------------------------------

// One shape for the queue item and the detail, spread rather than .extend()ed so the detail is a
// flat object in the OpenAPI document (no allOf) for the generated clients.
const messageReportShape = {
  id: uuidSchema,
  status: z.enum(MESSAGE_REPORT_STATUSES),
  priority: z.enum(MESSAGE_REPORT_PRIORITIES),
  respond_by: dateTimeSchema,
  is_overdue: z.boolean().openapi({
    description: "Still open (pending / in_review) and past respond_by.",
  }),
  reason_category: z.enum(MESSAGE_REPORT_REASONS),
  details: z.string().nullable(),
  conversation_id: uuidSchema,
  message_id: uuidSchema.nullable().openapi({
    description: "The reported message, or null when the user was reported in general.",
  }),
  reporter: reportPartySchema,
  reported: reportPartySchema,
  student: z
    .object({ id: uuidSchema, name: z.string() })
    .openapi({ description: "The child the thread is about." }),
  block_exists: z.boolean().openapi({
    description: "A messaging block currently stands between reporter and reported (either way).",
  }),
  resolution_note: z.string().nullable(),
  reviewed_by: z
    .object({ id: uuidSchema, name: z.string() })
    .nullable()
    .openapi({ description: "Who last moved the report out of pending." }),
  reviewed_at: dateTimeSchema.nullable(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
};

export const messageReportSchema = z.object(messageReportShape).openapi("MessageReport");

export const messageReportListSchema = z
  .object({
    reports: z.array(messageReportSchema).openapi({
      description:
        "Open reports first, then by priority (urgent, high, normal), then soonest respond_by.",
    }),
    total: z.number().int().min(0).openapi({ description: "Matching reports across all pages." }),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi("MessageReportList");

const reportEvidenceAttachmentSchema = z
  .object({
    id: uuidSchema,
    content_type: z.enum(MESSAGE_ATTACHMENT_CONTENT_TYPES),
    size_bytes: z.number().int().positive(),
    download_url: z.string().nullable().openapi({
      description: "5-minute pre-signed GET URL; null when object storage is not configured.",
    }),
    download_url_expires_at: dateTimeSchema.nullable(),
  })
  .openapi("MessageReportEvidenceAttachment");

export const messageReportDetailSchema = z
  .object({
    ...messageReportShape,
    messages: z
      .array(
        z
          .object({
            id: uuidSchema.openapi({ description: "The original message id." }),
            sender_id: uuidSchema,
            sender_name: z
              .string()
              .openapi({ description: "As it read when the report was filed." }),
            body: z.string(),
            created_at: dateTimeSchema,
            is_reported: z.boolean().openapi({ description: "This is the reported message." }),
            attachments: z.array(reportEvidenceAttachmentSchema),
          })
          .openapi("MessageReportEvidenceMessage"),
      )
      .openapi({
        description:
          "The evidence snapshot taken when the report was filed, oldest first: the reported " +
          "message and up to 20 before it, or the thread's last 20 for a general report.",
      }),
  })
  .openapi("MessageReportDetail");

export const messageReportEnvelopeSchema = z
  .object({ report: messageReportSchema })
  .openapi("MessageReportEnvelope");

export const messageReportDetailEnvelopeSchema = z
  .object({ report: messageReportDetailSchema })
  .openapi("MessageReportDetailEnvelope");

export const messageReportListQuerySchema = z.object({
  status: z
    .enum([...MESSAGE_REPORT_STATUSES, "open"])
    .optional()
    .openapi({ description: "Filter by status; `open` = pending + in_review. Omit for all." }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_MESSAGE_REPORT_PAGE_SIZE)
    .default(DEFAULT_MESSAGE_REPORT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

export const messageReportIdParamSchema = z.object({ reportId: uuidSchema });

export const updateMessageReportBodySchema = z
  .object({
    status: z.enum(["in_review", "actioned", "dismissed"]).openapi({
      description:
        "pending -> in_review | actioned | dismissed; in_review -> actioned | dismissed. " +
        "actioned and dismissed are final.",
    }),
    resolution_note: sanitizedTextSchema({ min: 1, max: MESSAGE_REPORT_RESOLUTION_NOTE_MAX_LENGTH })
      .optional()
      .openapi({ description: "Required for actioned / dismissed; 1-2000 characters." }),
  })
  .refine(
    (value) =>
      value.status === "in_review" ||
      (value.resolution_note !== undefined && value.resolution_note.length > 0),
    { path: ["resolution_note"], message: "A resolution note is required to close a report" },
  )
  .openapi("UpdateMessageReportBody");

export type CreateMessageReportInput = z.infer<typeof createMessageReportBodySchema>;
export type MessageReportReceipt = z.infer<typeof messageReportReceiptSchema>;
export type MessageReport = z.infer<typeof messageReportSchema>;
export type MessageReportDetail = z.infer<typeof messageReportDetailSchema>;
export type MessageReportListQuery = z.infer<typeof messageReportListQuerySchema>;
export type UpdateMessageReportInput = z.infer<typeof updateMessageReportBodySchema>;
