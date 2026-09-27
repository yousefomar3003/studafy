import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { dsrStatusSchema } from "../privacy/schemas";

import { RETAINED_RECORD_CATEGORY_NAMES } from "./retention-policy";

export const retainedRecordSchema = z
  .object({
    category: z.enum(RETAINED_RECORD_CATEGORY_NAMES),
    description: z.string(),
    legal_basis: z.string(),
  })
  .openapi("RetainedRecord");

export const accountDeletionResponseSchema = z
  .object({
    request_id: uuidSchema.openapi({
      description:
        "The erasure request filed for this deletion (GET /api/privacy/me/dsr lists it).",
    }),
    status: dsrStatusSchema,
    requested_at: dateTimeSchema,
    completes_by: dateTimeSchema.openapi({
      description: "Latest time by which personal data will have been erased.",
    }),
    ai_subscriptions_canceled: z.number().int().nonnegative().openapi({
      description: "AI add-on subscriptions that will not renew.",
    }),
    retained_records: z.array(retainedRecordSchema).openapi({
      description: "The only records kept after erasure, and the legal basis for each.",
    }),
  })
  .openapi("AccountDeletion");
