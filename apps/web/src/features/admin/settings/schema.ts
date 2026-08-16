import { z } from "zod";

/**
 * Client-side form schemas for the settings screens, each mirroring the request body its section
 * submits — `localeTimezoneSchema` / `invitationExpirySchema` / `attendanceAlertsSchema` against
 * `UpdateSchoolSettings` (apps/api/src/modules/tenancy/settings/schemas.ts), `profileSchema` against
 * `UpdateUserBody` (apps/api/src/modules/users/schemas.ts). Grading scheme has no schema of its own —
 * it's a closed `Select` over `GRADING_SCHEME_TYPES`, so there's no invalid state to reject client-side.
 *
 * `LOCALE_OPTIONS` / `GRADING_SCHEME_TYPES` mirror the onboarding setup wizard's copies
 * (routes/onboarding-setup/schema.ts) rather than importing them — routes compose features, not the
 * reverse, and each feature owning its small enum mirror is the existing convention (see that file's
 * own header comment on `schoolProfileSchema`).
 */

export const LOCALE_OPTIONS = ["en", "fr", "ar", "es", "pt", "de"] as const;

export const LOCALE_LABELS: Record<(typeof LOCALE_OPTIONS)[number], string> = {
  en: "English",
  fr: "Français",
  ar: "العربية",
  es: "Español",
  pt: "Português",
  de: "Deutsch",
};

export const GRADING_SCHEME_TYPES = [
  "letter",
  "percentage",
  "gpa",
  "numeric",
  "pass_fail",
] as const;

export const GRADING_SCHEME_LABELS: Record<(typeof GRADING_SCHEME_TYPES)[number], string> = {
  letter: "Letter (A, B, C…)",
  percentage: "Percentage (0-100%)",
  gpa: "GPA (0-4.5)",
  numeric: "Numeric score",
  pass_fail: "Pass / fail",
};

// Mirrors apps/api/src/modules/tenancy/settings/schemas.ts's `timezoneSchema` exactly.
const TIMEZONE_PATTERN = /^[A-Za-z]+\/[A-Za-z_]+$/;

export const profileSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(200, "Keep it under 200 characters"),
});
export type ProfileValues = z.infer<typeof profileSchema>;

export const localeTimezoneSchema = z.object({
  locale: z.enum(LOCALE_OPTIONS),
  timezone: z
    .string()
    .trim()
    .regex(TIMEZONE_PATTERN, "Must be a valid IANA timezone (e.g. Africa/Casablanca)."),
});
export type LocaleTimezoneValues = z.infer<typeof localeTimezoneSchema>;

export const invitationExpirySchema = z.object({
  invitation_expiry_days: z.coerce
    .number()
    .int("Enter a whole number of days.")
    .min(1, "Must be at least 1 day.")
    .max(365, "Must be 365 days or fewer."),
});
export type InvitationExpiryValues = z.infer<typeof invitationExpirySchema>;

export const attendanceAlertsSchema = z.object({
  attendance_alert_threshold: z.coerce
    .number()
    .min(0, "Must be between 0 and 100.")
    .max(100, "Must be between 0 and 100."),
  absence_alert_threshold: z.coerce
    .number()
    .min(0, "Must be between 0 and 100.")
    .max(100, "Must be between 0 and 100."),
  attendance_correction_window_hours: z.coerce
    .number()
    .int("Enter a whole number of hours.")
    .min(1, "Must be at least 1 hour.")
    .max(8760, "Must be 8760 hours (1 year) or fewer."),
  parent_discipline_visibility: z.boolean(),
});
export type AttendanceAlertsValues = z.infer<typeof attendanceAlertsSchema>;

/** First validation message per top-level field, for rendering against `Input`/`Select` `error` props. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");
    if (field && !(field in errors)) {
      // eslint-disable-next-line security/detect-object-injection -- `field` comes from this module's own Zod schema issues, and `errors` is a fresh local object, not a shared/prototype-bearing one
      errors[field] = issue.message;
    }
  }
  return errors;
}
