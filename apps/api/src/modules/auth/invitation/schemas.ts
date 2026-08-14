import { z } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const createInvitationBodySchema = z
  .object({
    email: z.string().email().max(320).openapi({
      description: "Email address to send the invitation to.",
      example: "newuser@example.com",
    }),
    role: z
      .enum([
        ROLES.ORG_ADMIN,
        ROLES.INSTRUCTOR,
        ROLES.TEACHING_ASSISTANT,
        ROLES.STUDENT,
        ROLES.GUEST,
      ])
      .openapi({
        description: "Role to assign when the invitation is accepted.",
        example: "STUDENT",
      }),
    expiry_days: z.number().int().min(1).max(365).optional().openapi({
      description:
        "Number of days until the invitation expires. Defaults to 7. Must be between 1 and 365.",
      example: 7,
    }),
  })
  .openapi("CreateInvitation");

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const invitationResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Unique invitation identifier." }),
    email: z.string().email().openapi({ description: "Invited email address." }),
    role: z.string().openapi({ description: "Role to be assigned on acceptance." }),
    expires_at: z.string().datetime().openapi({ description: "Expiry timestamp (ISO 8601)." }),
    created_at: z.string().datetime().openapi({ description: "Issuance timestamp (ISO 8601)." }),
  })
  .openapi("Invitation");

export const createInvitationResponseSchema = z
  .object({
    invitation: invitationResponseSchema,
    /**
     * The raw, one-time-use invitation token. This is the ONLY time it is returned.
     * It must be passed to the invitee and is never stored server-side.
     */
    token: z.string().openapi({
      description:
        "One-time-use invitation token (hex-encoded, 256-bit). " +
        "This is the only time the raw token is returned. Store it securely and " +
        "pass it to the invitee — it cannot be retrieved later.",
      example: "a1b2c3d4e5f6...",
    }),
  })
  .openapi("CreateInvitationResponse");

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const invitationIdPathParams = z
  .object({
    id: z
      .string()
      .uuid()
      .openapi({
        param: { name: "id", in: "path" },
        description: "Invitation identifier.",
        example: "8f14e45f-ceea-4a67-9a2d-1c3e7b0d5a91",
      }),
  })
  .openapi("InvitationIdPathParams");

export const invitationVerificationPathParams = z
  .object({
    // Format validation is deliberately performed inside the verification service. A Zod path
    // error retains the rejected value and the global error handler serializes that error to logs;
    // for a bearer credential that would turn validation into a secret-disclosure path.
    token: z.string().openapi({
      param: { name: "token", in: "path" },
      description: "One-time invitation bearer token (64 lowercase hexadecimal characters).",
      example: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    }),
  })
  .openapi("InvitationVerificationPathParams");

export const invitationVerificationResponseSchema = z
  .object({
    state: z.literal("valid"),
    emailHint: z.string().openapi({
      description: "Obfuscated normalized invitation email address.",
      example: "j***e@example.com",
    }),
    schoolName: z.string().openapi({ description: "Inviting school's display name." }),
  })
  .openapi("InvitationVerificationResponse");

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export const revokeInvitationResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Revoked invitation identifier." }),
    email: z.string().email().openapi({ description: "Invited email address." }),
    role: z.string().openapi({ description: "Role that was assigned." }),
    revoked_at: z.string().datetime().openapi({ description: "Revocation timestamp (ISO 8601)." }),
  })
  .openapi("RevokeInvitationResponse");

// ---------------------------------------------------------------------------
// Regenerate
// ---------------------------------------------------------------------------

export const regenerateInvitationResponseSchema = z
  .object({
    invitation: invitationResponseSchema,
    token: z.string().openapi({
      description:
        "One-time-use invitation token for the new invitation. " +
        "This is the only time the raw token is returned.",
    }),
    revoked_invitation_id: z.string().uuid().openapi({
      description: "ID of the old invitation that was revoked.",
    }),
  })
  .openapi("RegenerateInvitationResponse");

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export const invitationStatusValues = ["pending", "expired", "consumed", "revoked"] as const;

export const invitationStatusSchema = z.enum(invitationStatusValues).openapi({
  description:
    "Lifecycle state derived from expires_at/consumed_at/revoked_at — not a stored column.",
});

export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationWithStatusSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Unique invitation identifier." }),
    email: z.string().email().openapi({ description: "Invited email address." }),
    role: z.string().openapi({ description: "Role to be assigned on acceptance." }),
    status: invitationStatusSchema,
    expires_at: z.string().datetime().openapi({ description: "Expiry timestamp (ISO 8601)." }),
    revoked_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ description: "Revocation timestamp, null unless revoked." }),
    consumed_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ description: "Acceptance timestamp, null unless consumed." }),
    invited_by_user_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ description: "User who issued the invitation, if known." }),
    created_at: z.string().datetime().openapi({ description: "Issuance timestamp (ISO 8601)." }),
  })
  .openapi("InvitationWithStatus");

export const invitationListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    status: invitationStatusSchema.optional(),
    role: z
      .enum([
        ROLES.ORG_ADMIN,
        ROLES.INSTRUCTOR,
        ROLES.TEACHING_ASSISTANT,
        ROLES.STUDENT,
        ROLES.GUEST,
      ])
      .optional(),
    search: z
      .string()
      .min(1)
      .max(320)
      .optional()
      .openapi({ description: "Partial, case-insensitive match over email." }),
  })
  .openapi("InvitationListQuery");

export const invitationListResponseSchema = z
  .object({
    invitations: z.array(invitationWithStatusSchema),
    next_cursor: z.string().nullable().openapi({
      description: "Opaque cursor for the next page. Null when no more results.",
    }),
  })
  .openapi("InvitationList");

// ---------------------------------------------------------------------------
// Bulk invite
// ---------------------------------------------------------------------------

export const bulkInviteStatusValues = ["pending", "processing", "completed", "failed"] as const;

export const bulkInviteStatusSchema = z
  .enum(bulkInviteStatusValues)
  .openapi({ description: "Lifecycle state of the bulk invitation batch." });

export type BulkInviteStatus = z.infer<typeof bulkInviteStatusSchema>;

export const bulkInviteRecipientStatusValues = ["pending", "sent", "failed"] as const;

export const bulkInviteRecipientStatusSchema = z
  .enum(bulkInviteRecipientStatusValues)
  .openapi({ description: "Per-recipient dispatch state." });

export type BulkInviteRecipientStatus = z.infer<typeof bulkInviteRecipientStatusSchema>;

export const bulkInviteBodySchema = z
  .object({
    role: z
      .enum([
        ROLES.ORG_ADMIN,
        ROLES.INSTRUCTOR,
        ROLES.TEACHING_ASSISTANT,
        ROLES.STUDENT,
        ROLES.GUEST,
      ])
      .openapi({
        description: "Role to assign when each invitation is accepted.",
        example: "STUDENT",
      }),
    expiry_days: z.number().int().min(1).max(365).optional().openapi({
      description: "Number of days until each invitation expires. Defaults to 7.",
      example: 7,
    }),
    recipients: z
      .array(
        z.object({
          email: z.string().email().max(320).openapi({
            description: "Email address to invite.",
            example: "student@example.com",
          }),
        }),
      )
      .min(1)
      .max(5000)
      .openapi({
        description: "List of email addresses to invite. Maximum 5,000 recipients.",
      }),
  })
  .openapi("BulkInviteBody");

export const bulkInviteResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Bulk invite batch identifier." }),
    status: bulkInviteStatusSchema,
    role: z.string().openapi({ description: "Role assigned on acceptance." }),
    expiry_days: z.number().int().openapi({ description: "Days until invitations expire." }),
    target_mode: z
      .string()
      .openapi({ description: "Targeting mode (explicit, role, import_batch)." }),
    total_count: z.number().int().openapi({ description: "Total recipients in the batch." }),
    sent_count: z
      .number()
      .int()
      .openapi({ description: "Recipients with successfully created invitations." }),
    failed_count: z
      .number()
      .int()
      .openapi({ description: "Recipients where invitation creation failed." }),
    created_at: z.string().datetime().openapi({ description: "Batch creation timestamp." }),
    updated_at: z.string().datetime().openapi({ description: "Last state change." }),
    completed_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ description: "When all recipients were processed." }),
  })
  .openapi("BulkInviteResponse");

export const bulkInviteRecipientSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Recipient row identifier." }),
    email: z.string().email().openapi({ description: "Invited email address." }),
    status: bulkInviteRecipientStatusSchema,
    invitation_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ description: "Created invitation ID (null until sent)." }),
    error_message: z
      .string()
      .nullable()
      .openapi({ description: "Failure reason (null on success)." }),
    created_at: z.string().datetime().openapi({ description: "Row creation timestamp." }),
    updated_at: z.string().datetime().openapi({ description: "Last state change." }),
  })
  .openapi("BulkInviteRecipient");

export const bulkInviteListResponseSchema = z
  .object({
    bulk_invites: z.array(bulkInviteResponseSchema),
    next_cursor: z.string().nullable().openapi({
      description: "Opaque cursor for the next page. Null when no more results.",
    }),
  })
  .openapi("BulkInviteList");

export const bulkInviteRecipientsResponseSchema = z
  .object({
    recipients: z.array(bulkInviteRecipientSchema),
    next_cursor: z.string().nullable().openapi({
      description: "Opaque cursor for the next page. Null when no more results.",
    }),
  })
  .openapi("BulkInviteRecipients");

export const bulkInviteIdPathParams = z
  .object({
    bulkInviteId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "bulkInviteId", in: "path" },
        description: "Bulk invite batch UUID.",
      }),
  })
  .openapi("BulkInviteIdPathParams");

export const bulkInviteRecipientsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    status: bulkInviteRecipientStatusSchema.optional(),
  })
  .openapi("BulkInviteRecipientsQuery");
