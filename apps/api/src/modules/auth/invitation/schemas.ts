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
