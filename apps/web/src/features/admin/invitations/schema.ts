import { z } from "zod";

import { fieldErrors, ROLE_LABEL_KEYS } from "../users/schema";

import type { Role } from "@studafy/constants";

export { fieldErrors, ROLE_LABEL_KEYS };

/**
 * Roles the invitation endpoints accept — `createInvitationBodySchema` /
 * `bulkInviteBodySchema` in `apps/api/src/modules/auth/invitation/schemas.ts`. Deliberately not the
 * same list as the users feature's `ASSIGNABLE_ROLES`: invitations additionally exclude `FINANCE`,
 * `PARENT`, and `SUPPORT_AGENT`, which the API rejects with a 400 if sent here.
 */
export const INVITATION_ROLES = [
  "ORG_ADMIN",
  "PRINCIPAL",
  "INSTRUCTOR",
  "TEACHING_ASSISTANT",
  "STUDENT",
  "GUEST",
] as const satisfies readonly Role[];

export type InvitationRole = (typeof INVITATION_ROLES)[number];

/**
 * Status display names as translation keys, resolved with `t()` at render time so they follow a
 * runtime language switch. Validation messages in the schemas below are translation keys too.
 */
export const INVITATION_STATUS_LABEL_KEYS = {
  pending: "adminPeople.invitations.status.pending",
  expired: "adminPeople.invitations.status.expired",
  consumed: "adminPeople.invitations.status.consumed",
  revoked: "adminPeople.invitations.status.revoked",
} as const;

export type InvitationStatus = keyof typeof INVITATION_STATUS_LABEL_KEYS;

export const BULK_INVITE_STATUS_LABEL_KEYS = {
  pending: "adminPeople.invitations.bulkStatus.pending",
  processing: "adminPeople.invitations.bulkStatus.processing",
  completed: "adminPeople.invitations.bulkStatus.completed",
  failed: "adminPeople.invitations.bulkStatus.failed",
} as const;

export const BULK_RECIPIENT_STATUS_LABEL_KEYS = {
  pending: "adminPeople.invitations.recipientStatus.pending",
  sent: "adminPeople.invitations.recipientStatus.sent",
  failed: "adminPeople.invitations.recipientStatus.failed",
} as const;

const invitationRoleEnum = z.enum(INVITATION_ROLES);
const expiryDaysSchema = z
  .number()
  .int()
  .min(1, "adminPeople.validation.expiryMin")
  .max(365, "adminPeople.validation.expiryMax")
  .optional();

export const createInvitationSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "adminPeople.validation.emailRequired")
    .email("adminPeople.validation.emailInvalid"),
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
    .array(z.string().trim().email("adminPeople.validation.recipientInvalid"))
    .min(1, "adminPeople.validation.recipientsMin")
    .max(5000, "adminPeople.validation.recipientsMax"),
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
