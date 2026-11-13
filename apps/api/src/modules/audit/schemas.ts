import { z } from "@hono/zod-openapi";
import { AUDIT_ACTIONS } from "@studafy/audit-reporting";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

const auditFilterFields = {
  from: z.string().datetime().optional().openapi({
    description: "Inclusive lower bound for created_at, as ISO-8601 (defaults to 30 days ago).",
  }),
  to: z.string().datetime().optional().openapi({
    description: "Exclusive upper bound for created_at, as ISO-8601 (defaults to now).",
  }),
  actor_id: uuidSchema.optional().openapi({ description: "Restrict to one actor." }),
  action: z.enum(AUDIT_ACTIONS).optional().openapi({ description: "Restrict to one action." }),
  target_table: z.string().max(63).optional().openapi({
    description: "Restrict to rows whose target table matches.",
  }),
  target_id: uuidSchema.optional().openapi({
    description: "Restrict to rows whose target UUID matches.",
  }),
};

export const auditLogQuerySchema = z
  .object({
    ...auditFilterFields,
    limit: z.coerce.number().int().min(1).max(500).default(100).openapi({
      description: "Maximum number of entries in this page.",
    }),
    cursor: z.string().min(1).optional().openapi({
      description: "Opaque keyset cursor from the previous page.",
    }),
  })
  .openapi("AuditLogQuery");

export const auditExportBodySchema = z
  .object({
    ...auditFilterFields,
  })
  .openapi("AuditExportBody");

export const auditExportJobIdParamSchema = z
  .object({
    jobId: uuidSchema.openapi({
      param: { name: "jobId", in: "path" },
      description: "Audit export job UUID.",
    }),
  })
  .openapi("AuditExportJobIdParam");

export const auditLogActionSchema = z.enum(AUDIT_ACTIONS);
export const auditExportStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);

export const auditLogEntrySchema = z
  .object({
    id: uuidSchema,
    created_at: dateTimeSchema,
    action: auditLogActionSchema,
    actor_id: uuidSchema.nullable(),
    actor_name: z.string().nullable(),
    actor_email: z.string().nullable(),
    target_table: z.string(),
    target_id: uuidSchema,
    client_ip: z.string().nullable(),
    user_agent: z.string().nullable(),
    request_id: uuidSchema.nullable(),
    old_values: z.record(z.string(), z.unknown()).nullable(),
    new_values: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi("AuditLogEntry");

export const auditLogFilterResponseSchema = z
  .object({
    from: dateTimeSchema,
    to: dateTimeSchema,
    actor_id: uuidSchema.optional(),
    action: auditLogActionSchema.optional(),
    target_table: z.string().optional(),
    target_id: uuidSchema.optional(),
  })
  .openapi("AuditLogFilter");

export const auditLogPageResponseSchema = z
  .object({
    generated_at: dateTimeSchema,
    filter: auditLogFilterResponseSchema,
    limit: z.number().int(),
    items: z.array(auditLogEntrySchema),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  })
  .openapi("AuditLogPage");

export const auditExportJobSchema = z
  .object({
    id: uuidSchema,
    file_format: z.literal("csv"),
    status: auditExportStatusSchema,
    created_at: dateTimeSchema,
    completed_at: dateTimeSchema.nullable(),
    download_url: z.string().url().nullable(),
    download_url_expires_at: dateTimeSchema.nullable(),
    failure_message: z.string().nullable(),
  })
  .openapi("AuditExportJob");
