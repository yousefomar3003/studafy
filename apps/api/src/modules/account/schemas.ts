import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

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
          scheduled_for: dateTimeSchema.openapi({
            description: "When this account is detached and its erasure filed, unless cancelled.",
          }),
          completes_by: dateTimeSchema.openapi({
            description: "Latest time by which this account's personal data will have been erased.",
          }),
        }),
      )
      .openapi({
        description:
          "One entry per account scheduled for deletion. Empty when the address no longer has an " +
          "active account without a deletion already scheduled.",
      }),
    retained_records: z.array(retainedRecordSchema),
  })
  .openapi("AccountDeletionConfirmed");

export const accountDeletionBodySchema = z
  .object({
    member_id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .openapi({
        description:
          "The caller's own member ID. Required when the caller signs in with a member ID and " +
          "password (see AccountProfile.deletion_requires_member_credentials).",
        example: "PAR-0001",
      }),
    password: z.string().min(1).max(128).optional().openapi({
      description: "The caller's current password. Required alongside member_id.",
    }),
  })
  .openapi("AccountDeletionConfirmation");

export const accountDeletionResponseSchema = z
  .object({
    status: z.literal("scheduled"),
    requested_at: dateTimeSchema,
    scheduled_for: dateTimeSchema.openapi({
      description:
        "When the account is detached from the school and its erasure filed. Signing in before " +
        "then and calling DELETE /api/account/deletion cancels it.",
    }),
    completes_by: dateTimeSchema.openapi({
      description: "Latest time by which personal data will have been erased.",
    }),
    retained_records: z.array(retainedRecordSchema).openapi({
      description: "The only records kept after erasure, and the legal basis for each.",
    }),
  })
  .openapi("AccountDeletion");

export const accountProfileSchema = z
  .object({
    user_id: uuidSchema.openapi({ description: "The caller's own user id." }),
    display_name: z.string().nullable().openapi({
      description: "Human-readable name. Null when none was ever set.",
      example: "Fatima Al-Sabah",
    }),
    email: z.string().max(320).nullable().openapi({
      description: "Contact address. Null for members who sign in with a member ID and password.",
    }),
    member_ids: z.array(z.string()).openapi({
      description:
        "The member IDs the caller signs in with, one per kind (a teacher who is also a parent has " +
        "two). Empty for users who only sign in by email or SSO.",
      example: ["TCH-0001"],
    }),
    deletion_scheduled_for: dateTimeSchema.nullable().openapi({
      description:
        "When the caller's scheduled deletion runs; null when none is scheduled. While set, the " +
        "session may only read this profile, cancel the deletion or log out.",
    }),
    deletion_requires_member_credentials: z.boolean().openapi({
      description:
        "Whether POST /api/account/deletion needs the caller's member_id and password (accounts " +
        "that sign in with a member ID and password).",
    }),
    school: z
      .object({
        id: uuidSchema,
        name: z.string().openapi({ example: "Al-Noor Academy" }),
      })
      .openapi({ description: "The school this session is signed in to." }),
  })
  .openapi("AccountProfile");
