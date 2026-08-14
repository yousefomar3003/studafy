import { z } from "zod";

import { fieldErrors, ROLE_LABELS } from "../users/schema";

import type { Role } from "@studafy/constants";

export { fieldErrors, ROLE_LABELS };

/**
 * Roles the invitation endpoints accept — `createInvitationBodySchema` /
 * `bulkInviteBodySchema` in `apps/api/src/modules/auth/invitation/schemas.ts`. Deliberately not the
 * same list as the users feature's `ASSIGNABLE_ROLES`: invitations additionally exclude `FINANCE`,
 * `PARENT`, and `SUPPORT_AGENT`, which the API rejects with a 400 if sent here.
 */
export const INVITATION_ROLES = [
  "ORG_ADMIN",
  "INSTRUCTOR",
  "TEACHING_ASSISTANT",
  "STUDENT",
  "GUEST",
] as const satisfies readonly Role[];

export type InvitationRole = (typeof INVITATION_ROLES)[number];

export const INVITATION_STATUS_LABELS = {
  pending: "Pending",
  expired: "Expired",
  consumed: "Consumed",
  revoked: "Revoked",
} as const;

export type InvitationStatus = keyof typeof INVITATION_STATUS_LABELS;

export const BULK_INVITE_STATUS_LABELS = {
  pending: "Pending",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
} as const;

export const BULK_RECIPIENT_STATUS_LABELS = {
  pending: "Pending",
  sent: "Sent",
  failed: "Failed",
} as const;

const invitationRoleEnum = z.enum(INVITATION_ROLES);
const expiryDaysSchema = z
  .number()
  .int()
  .min(1, "Must be at least 1 day")
  .max(365, "Must be 365 days or fewer")
  .optional();

export const createInvitationSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email address"),
  role: invitationRoleEnum,
  expiry_days: expiryDaysSchema,
});
export type CreateInvitationValues = z.infer<typeof createInvitationSchema>;

/**
 * Validates the already-split, already-deduped recipient list. Parsing the raw textarea into this
 * array (split on whitespace/commas/semicolons, trim, dedupe case-insensitively) is
 * `BulkInviteModal`'s job — this schema only checks the result, matching how `createInvitationSchema`
 * only ever sees a single already-trimmed email.
 */
export const bulkInviteSchema = z.object({
  role: invitationRoleEnum,
  expiry_days: expiryDaysSchema,
  recipients: z
    .array(z.string().trim().email())
    .min(1, "Add at least one recipient")
    .max(5000, "Maximum 5,000 recipients per batch"),
});
export type BulkInviteValues = z.infer<typeof bulkInviteSchema>;

/** Splits pasted/typed recipient text on whitespace, commas, and semicolons, then dedupes. */
export function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of raw.split(/[\s,;]+/)) {
    const email = candidate.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(email);
  }
  return result;
}
