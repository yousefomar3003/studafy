import { ROLES } from "@studafy/constants";
import { z } from "zod";

import type { Role } from "@studafy/constants";

/**
 * Assignable roles for this UI, deliberately narrower than `ROLES`. `SUPER_ADMIN` holds every
 * permission in the matrix (`packages/constants/src/permissions.ts`), and the create/update-role
 * endpoints place no ceiling on which role a caller may assign — an `ORG_ADMIN` can mint another
 * `SUPER_ADMIN` today. Excluding it from the picker is a UI-layer guardrail against that, not a fix
 * for the underlying gap; the API itself still needs a role-assignment ceiling.
 */
export const ASSIGNABLE_ROLES = Object.values(ROLES).filter(
  (role) => role !== ROLES.SUPER_ADMIN,
) as Role[];

/**
 * Translation keys for each role's display name, resolved with `t()` at render time so the label
 * follows a runtime language switch.
 */
export const ROLE_LABEL_KEYS: Record<Role, string> = {
  SUPER_ADMIN: "adminPeople.roles.SUPER_ADMIN",
  ORG_ADMIN: "adminPeople.roles.ORG_ADMIN",
  FINANCE: "adminPeople.roles.FINANCE",
  INSTRUCTOR: "adminPeople.roles.INSTRUCTOR",
  TEACHING_ASSISTANT: "adminPeople.roles.TEACHING_ASSISTANT",
  STUDENT: "adminPeople.roles.STUDENT",
  PARENT: "adminPeople.roles.PARENT",
  GUEST: "adminPeople.roles.GUEST",
  SUPPORT_AGENT: "adminPeople.roles.SUPPORT_AGENT",
};

/** Translation keys for each user status's display name; resolve with `t()` at render time. */
export const STATUS_LABEL_KEYS = {
  invited: "adminPeople.users.status.invited",
  active: "adminPeople.users.status.active",
  suspended: "adminPeople.users.status.suspended",
  archived: "adminPeople.users.status.archived",
} as const;

export type UserStatus = keyof typeof STATUS_LABEL_KEYS;

/**
 * Validation messages below are translation keys, not display text: `fieldErrors` hands them back
 * as-is and the form translates them with `t()` where the error renders.
 */

const roleEnum = z.enum(ASSIGNABLE_ROLES as [Role, ...Role[]]);

export const createUserSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "adminPeople.validation.emailRequired")
    .email("adminPeople.validation.emailInvalid"),
  display_name: z
    .string()
    .trim()
    .max(200, "adminPeople.validation.maxLength200")
    .optional()
    .transform((value) => (value ? value : undefined)),
  role: roleEnum,
});
export type CreateUserValues = z.infer<typeof createUserSchema>;

export const editUserSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, "adminPeople.validation.nameRequired")
    .max(200, "adminPeople.validation.maxLength200"),
  role: roleEnum,
});
export type EditUserValues = z.infer<typeof editUserSchema>;

/** Maps a `ZodError` to one message per field, keeping only the first issue per path. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");
    if (field && !(field in errors)) {
      // eslint-disable-next-line security/detect-object-injection -- `field` comes from this module's own Zod schema issues, and `errors` is a fresh local object
      errors[field] = issue.message;
    }
  }
  return errors;
}
