import { z } from "@hono/zod-openapi";

import { schoolStatusSchema } from "./schemas";

/**
 * Request/response contracts for the platform console's per-account support actions
 * (`/api/platform/schools/{schoolId}/users/{userId}...`). camelCase, like the rest of the console.
 */

const isoDateTime = z.string().datetime();

export const supportUserParamSchema = z.object({
  schoolId: z
    .string()
    .uuid()
    .openapi({ param: { name: "schoolId", in: "path" }, description: "The account's school." }),
  userId: z
    .string()
    .uuid()
    .openapi({ param: { name: "userId", in: "path" }, description: "The account." }),
});

/** Every support action carries a reason, recorded in both audit rows. */
export const supportActionBodySchema = z
  .object({
    reason: z.string().trim().min(3).max(500).openapi({
      description:
        "Why the action was taken. Recorded in the school's and the operator's audit log.",
    }),
  })
  .openapi("PlatformSupportActionBody");

export const supportPersonSchema = z
  .object({
    /** The other side's display or legal name. Names only: no contact details cross this link. */
    name: z.string().nullable(),
    relationship: z.string(),
  })
  .openapi("PlatformSupportLinkedPerson");

export const supportUserSchema = z
  .object({
    school: z.object({ id: z.string().uuid(), name: z.string(), status: schoolStatusSchema }),
    userId: z.string().uuid(),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    status: z.string(),
    roles: z.array(z.string()),
    memberCodes: z.array(z.string()),
    createdAt: isoDateTime,
    lastLoginAt: isoDateTime.nullable(),
    /** Signed in at least once, verified an email, or set a member password. */
    activated: z.boolean(),
    signIn: z.object({
      /** Linked Google / Microsoft identities, by provider name. */
      providers: z.array(z.string()),
      /** A member password is set (member-ID sign-in). */
      memberPassword: z.boolean(),
      /** Locked out after repeated wrong member passwords, until `lockedUntil`. */
      locked: z.boolean(),
      lockedUntil: isoDateTime.nullable(),
      failedAttempts: z.number().int(),
    }),
    activeSessions: z.number().int(),
    /** The most recent invitation for the account's email, if any. */
    invitation: z
      .object({
        status: z.enum(["pending", "expired", "revoked", "accepted"]),
        expiresAt: isoDateTime,
        createdAt: isoDateTime,
      })
      .nullable(),
    /** For a parent: their linked children. */
    children: z.array(supportPersonSchema),
    /** For a student: their linked parents. */
    parents: z.array(supportPersonSchema),
    /** False for another SUPER_ADMIN's account: the console never acts on platform staff. */
    actionable: z.boolean(),
    /** The operator's own account, which cannot be deactivated from here. */
    isSelf: z.boolean(),
  })
  .openapi("PlatformSupportUser");

export const resendInvitationResultSchema = z
  .object({
    /** The new invitation. The token is emailed to the account's own address, never returned. */
    invitationId: z.string().uuid(),
    expiresAt: isoDateTime,
  })
  .openapi("PlatformSupportInvitationResent");

export const signOutResultSchema = z
  .object({ revokedSessions: z.number().int(), denylistedTokens: z.number().int() })
  .openapi("PlatformSupportSignedOut");

export const unlockResultSchema = z
  .object({ wasLocked: z.boolean(), failedAttemptsCleared: z.number().int() })
  .openapi("PlatformSupportUnlocked");

export const statusChangeResultSchema = z
  .object({
    status: z.string(),
    revokedSessions: z.number().int(),
    invitationsRevoked: z.number().int(),
  })
  .openapi("PlatformSupportStatusChanged");
