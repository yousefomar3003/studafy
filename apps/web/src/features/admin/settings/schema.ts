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

/** Each language's own name (endonym), deliberately not translated: a language picker lists every
 * option in its own script so a reader can find theirs regardless of the current UI language. */
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

/** Translation key for a grading scheme's display name, resolved with `t()` at render time. */
export function gradingSchemeLabelKey(scheme: (typeof GRADING_SCHEME_TYPES)[number]): string {
  return `adminSchool.settings.grading.schemes.${scheme}`;
}

// Mirrors apps/api/src/modules/tenancy/settings/schemas.ts's `timezoneSchema` exactly.
const TIMEZONE_PATTERN = /^[A-Za-z]+\/[A-Za-z_]+$/;

export const profileSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, "adminSchool.settings.validation.nameRequired")
    .max(200, "adminSchool.settings.validation.nameTooLong"),
});
export type ProfileValues = z.infer<typeof profileSchema>;

export const localeTimezoneSchema = z.object({
  locale: z.enum(LOCALE_OPTIONS),
  timezone: z
    .string()
    .trim()
    .regex(TIMEZONE_PATTERN, "adminSchool.settings.validation.invalidTimezone"),
});
export type LocaleTimezoneValues = z.infer<typeof localeTimezoneSchema>;

export const invitationExpirySchema = z.object({
  invitation_expiry_days: z.coerce
    .number()
    .int("adminSchool.settings.validation.wholeDays")
    .min(1, "adminSchool.settings.validation.minDays")
    .max(365, "adminSchool.settings.validation.maxDays"),
});
export type InvitationExpiryValues = z.infer<typeof invitationExpirySchema>;

export const attendanceAlertsSchema = z.object({
  attendance_alert_threshold: z.coerce
    .number()
    .min(0, "adminSchool.settings.validation.percentRange")
    .max(100, "adminSchool.settings.validation.percentRange"),
  absence_alert_threshold: z.coerce
    .number()
    .min(0, "adminSchool.settings.validation.percentRange")
    .max(100, "adminSchool.settings.validation.percentRange"),
  attendance_correction_window_hours: z.coerce
    .number()
    .int("adminSchool.settings.validation.wholeHours")
    .min(1, "adminSchool.settings.validation.minHours")
    .max(8760, "adminSchool.settings.validation.maxHours"),
  parent_discipline_visibility: z.boolean(),
});
export type AttendanceAlertsValues = z.infer<typeof attendanceAlertsSchema>;

/** First validation message per top-level field, for rendering against `Input`/`Select` `error` props.
 * Schema messages above are translation keys — resolve them with `t()` where they are displayed. */
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
