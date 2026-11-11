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
    export_deleted_at: dateTimeSchema.nullable().openapi({
      description:
        "When a finished export's stored bundle was deleted by the data retention sweep, 30 days " +
        "after completion; null while it is still stored, and always null for an erasure. Once set " +
        "the request has no download link any more.",
    }),
    failure_message: z.string().nullable(),
  })
  .openapi("DataSubjectRequest");

/** Self-service filing: no `subject_user_id` field -- the caller is always the subject. */
export const createSelfDsrBodySchema = z
  .object({
    request_type: dsrRequestTypeSchema.openapi({
      description:
        "'export' (GDPR Art. 15) or 'erasure' (GDPR Art. 17), filed by the caller about their own account.",
    }),
  })
  .openapi("CreateSelfDataSubjectRequestBody");

export const dsrListResponseSchema = z.array(dsrResponseSchema).openapi("DataSubjectRequestList");

export const listDsrQuerySchema = z
  .object({
    subject_user_id: uuidSchema.optional().openapi({ description: "Only this person's requests." }),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .openapi("DataSubjectRequestListQuery");

export const schoolDsrSchema = dsrResponseSchema
  .extend({
    subject_display_name: z.string().nullable().openapi({
      description:
        "The person's name. Once an erasure has run it is gone: null, or an `erased-<uuid>` placeholder.",
    }),
  })
  .openapi("SchoolDataSubjectRequest");

export const schoolDsrListResponseSchema = z
  .object({ requests: z.array(schoolDsrSchema) })
  .openapi("SchoolDataSubjectRequestList");
