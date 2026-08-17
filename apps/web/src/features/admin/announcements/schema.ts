import { ROLES } from "@studafy/constants";
import { z } from "zod";

import type { CreateAnnouncementBody } from "./queries";
import type { Role } from "@studafy/constants";
import type { SelectOption } from "@studafy/ui";

export type AnnouncementAudienceType = "school" | "role" | "class";

export const AUDIENCE_TYPE_LABELS: Record<AnnouncementAudienceType, string> = {
  school: "Everyone in the school",
  role: "Everyone with a role",
  class: "Everyone in a class",
};

/**
 * Duplicated from `users/schema.ts` rather than imported — each admin feature folder is
 * self-contained (see `audit/queries.ts`'s `toIsoDateBoundary` for the same precedent). Unlike
 * `ASSIGNABLE_ROLES` (which excludes SUPER_ADMIN as a privilege-assignment ceiling), audience
 * targeting has no such ceiling — addressing a notice to every SUPER_ADMIN is a legitimate audience.
 */
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

export const ROLE_OPTIONS: SelectOption<Role>[] = Object.values(ROLES).map((role) => ({
  value: role,
  // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `ROLES` values, not user input
  label: ROLE_LABELS[role],
}));

/**
 * The compose form's own value shape — `scheduled_at_local` is a `datetime-local` input's raw
 * string (e.g. "2026-08-20T09:00"), not the ISO instant the API wants. `<input type="datetime-local">`
 * has no timezone of its own: the browser reports and later re-parses it in whatever zone the device
 * is set to, so `new Date(scheduled_at_local)` (done in `toCreateAnnouncementBody` below) already
 * resolves to the correct UTC instant regardless of which timezone the admin is composing from — an
 * admin in Tokyo scheduling "9:00 AM" gets a different UTC instant than one in Casablanca typing the
 * same digits, which is exactly what "works across timezones" requires.
 */
export const composeAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(200, "Keep it under 200 characters"),
    body: z
      .string()
      .trim()
      .min(1, "Message is required")
      .max(5000, "Keep it under 5,000 characters"),
    mandatory: z.boolean(),
    audience_type: z.enum(["school", "role", "class"]),
    audience_role: z.string().optional(),
    audience_class_id: z.string().optional(),
    scheduled_at_local: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.audience_type === "role" && !value.audience_role) {
      ctx.addIssue({
        code: "custom",
        path: ["audience_role"],
        message: "Choose a role",
      });
    }
    if (value.audience_type === "class" && !value.audience_class_id) {
      ctx.addIssue({
        code: "custom",
        path: ["audience_class_id"],
        message: "Choose a class",
      });
    }
    if (value.scheduled_at_local && Number.isNaN(new Date(value.scheduled_at_local).getTime())) {
      ctx.addIssue({ code: "custom", path: ["scheduled_at_local"], message: "Invalid date/time" });
    }
  });

export type ComposeAnnouncementValues = z.infer<typeof composeAnnouncementSchema>;

export const EMPTY_COMPOSE_VALUES: ComposeAnnouncementValues = {
  title: "",
  body: "",
  mandatory: false,
  audience_type: "school",
  audience_role: undefined,
  audience_class_id: undefined,
  scheduled_at_local: "",
};

/** Maps a `ZodError` to one message per field, keeping only the first issue per path — matches
 * `users/schema.ts`'s `fieldErrors`, duplicated for the same self-contained-feature reason. */
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

/** Converts validated form values to the wire shape, mirroring
 * `createAnnouncementBodySchema`'s discriminated audience shape (apps/api/src/modules/announcements/schemas.ts):
 * only the field matching `audience_type` is sent, and an empty `scheduled_at_local` means "publish
 * now" (the API's own default when `scheduled_at` is omitted). */
export function toCreateAnnouncementBody(
  values: ComposeAnnouncementValues,
): CreateAnnouncementBody {
  return {
    title: values.title,
    body: values.body,
    mandatory: values.mandatory,
    audience_type: values.audience_type,
    ...(values.audience_type === "role" ? { audience_role: values.audience_role as Role } : {}),
    ...(values.audience_type === "class" ? { audience_class_id: values.audience_class_id } : {}),
    ...(values.scheduled_at_local
      ? { scheduled_at: new Date(values.scheduled_at_local).toISOString() }
      : {}),
  } as CreateAnnouncementBody;
}
