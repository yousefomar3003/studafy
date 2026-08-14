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

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super admin",
  ORG_ADMIN: "Org admin",
  FINANCE: "Finance",
  INSTRUCTOR: "Instructor",
  TEACHING_ASSISTANT: "Teaching assistant",
  STUDENT: "Student",
  PARENT: "Parent",
  GUEST: "Guest",
  SUPPORT_AGENT: "Support agent",
};

export const STATUS_LABELS = {
  invited: "Invited",
  active: "Active",
  suspended: "Suspended",
  archived: "Archived",
} as const;

export type UserStatus = keyof typeof STATUS_LABELS;

const roleEnum = z.enum(ASSIGNABLE_ROLES as [Role, ...Role[]]);

export const createUserSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email address"),
  display_name: z
    .string()
    .trim()
    .max(200, "Keep it under 200 characters")
    .optional()
    .transform((value) => (value ? value : undefined)),
  role: roleEnum,
});
export type CreateUserValues = z.infer<typeof createUserSchema>;

export const editUserSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(200, "Keep it under 200 characters"),
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
