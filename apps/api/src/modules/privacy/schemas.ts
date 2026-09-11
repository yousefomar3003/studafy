import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

export const dsrRequestTypeSchema = z.enum(["export", "erasure"]);
export const dsrStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);

export const createDsrBodySchema = z
  .object({
    subject_user_id: uuidSchema.openapi({
      description: "The user this request is about.",
    }),
    request_type: dsrRequestTypeSchema.openapi({
      description: "'export' (GDPR Art. 15) or 'erasure' (GDPR Art. 17).",
    }),
  })
  .openapi("CreateDataSubjectRequestBody");

export const dsrIdParamSchema = z
  .object({
    requestId: uuidSchema.openapi({
      param: { name: "requestId", in: "path" },
      description: "Data subject request UUID.",
    }),
  })
  .openapi("DataSubjectRequestIdParam");

export const dsrResponseSchema = z
  .object({
    id: uuidSchema,
    request_type: dsrRequestTypeSchema,
    subject_user_id: uuidSchema,
    status: dsrStatusSchema,
    created_at: dateTimeSchema,
    completed_at: dateTimeSchema.nullable(),
    sla_due_at: dateTimeSchema,
    download_url: z.string().url().nullable(),
    download_url_expires_at: dateTimeSchema.nullable(),
    failure_message: z.string().nullable(),
  })
  .openapi("DataSubjectRequest");
