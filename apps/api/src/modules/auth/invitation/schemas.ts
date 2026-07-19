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
