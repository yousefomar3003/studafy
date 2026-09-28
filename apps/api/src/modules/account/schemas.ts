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

export const accountDeletionRequestBodySchema = z
  .object({
    email: z.string().email().max(320).openapi({
      description: "Email address of the account(s) to delete.",
      example: "parent@example.com",
    }),
    captcha_token: z.string().min(1).openapi({ description: "Cloudflare Turnstile token." }),
  })
  .openapi("AccountDeletionRequest");

export const accountDeletionRequestResponseSchema = z
  .object({
    message: z.string().openapi({
      description: "Identical whether or not the address has an account, to prevent enumeration.",
    }),
  })
  .openapi("AccountDeletionRequestAccepted");

export const accountDeletionConfirmBodySchema = z
  .object({
    // Format is checked in the service, not here, so a malformed token and an unknown one produce
    // the same error and neither is echoed into validation logs.
    token: z.string().max(256).openapi({ description: "The token from the emailed link." }),
  })
  .openapi("AccountDeletionConfirm");

export const accountDeletionConfirmResponseSchema = z
  .object({
    accounts: z
      .array(
        z.object({
          school_name: z.string(),
          request_id: uuidSchema,
          completes_by: dateTimeSchema.openapi({
            description: "Latest time by which this account's personal data will have been erased.",
          }),
        }),
      )
      .openapi({
        description:
          "One entry per account deleted. Empty when the address no longer has an active account.",
      }),
    retained_records: z.array(retainedRecordSchema),
  })
  .openapi("AccountDeletionConfirmed");

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
