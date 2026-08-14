import { z } from "zod";

/**
 * Client-side form schemas for the setup wizard's steps. Each mirrors the request body its step
 * submits — `schoolProfileSchema` against `UpdateSchoolSettings`
 * (apps/api/src/modules/tenancy/settings/schemas.ts), `academicYearSchema` against
 * `CreateAcademicYearBody`, `gradingSchemeSchema` against `CreateGradingSchemeBody`
 * (apps/api/src/modules/grades/config/schemas.ts) — so "Next" rejects bad input inline instead of
 * round-tripping to the server for every mistake.
 *
 * The timetable step's period template (count + weekdays) has no backend field to mirror: the
 * timetable API only models version/slot scheduling, not clock-time period definitions, so that
 * part of the step is validated here and kept client-side only (see `progress.ts`).
 */

export const LOCALE_OPTIONS = ["en", "fr", "ar", "es", "pt", "de"] as const;

export const GRADING_SCHEME_TYPES = [
  "letter",
  "percentage",
  "gpa",
  "numeric",
  "pass_fail",
] as const;

export const STAFF_INVITE_ROLES = ["ORG_ADMIN", "INSTRUCTOR", "TEACHING_ASSISTANT"] as const;

export const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
] as const;

// Mirrors apps/api/src/modules/tenancy/settings/schemas.ts's `timezoneSchema` exactly.
const TIMEZONE_PATTERN = /^[A-Za-z]+\/[A-Za-z_]+$/;

export const schoolProfileSchema = z.object({
  locale: z.enum(LOCALE_OPTIONS),
  timezone: z
    .string()
    .trim()
    .regex(TIMEZONE_PATTERN, "Must be a valid IANA timezone (e.g. Africa/Casablanca)."),
  invitation_expiry_days: z.coerce.number().int().min(1).max(365),
  attendance_alert_threshold: z.coerce.number().min(0).max(100),
  absence_alert_threshold: z.coerce.number().min(0).max(100),
  parent_discipline_visibility: z.boolean(),
  attendance_correction_window_hours: z.coerce.number().int().min(1).max(8760),
});

export type SchoolProfileValues = z.infer<typeof schoolProfileSchema>;

export const academicYearSchema = z
  .object({
    code: z.string().trim().min(1, "Enter a short code.").max(50),
    name: z.string().trim().min(1, "Enter a name.").max(200),
    starts_on: z.string().date("Enter a valid start date."),
    ends_on: z.string().date("Enter a valid end date."),
  })
  .refine((v) => v.starts_on < v.ends_on, {
    message: "End date must be after the start date.",
    path: ["ends_on"],
  });

export type AcademicYearValues = z.infer<typeof academicYearSchema>;

export const gradeBoundaryRowSchema = z
  .object({
    label: z.string().trim().min(1, "Enter a label."),
    min: z.coerce.number().min(0).max(100),
    max: z.coerce.number().min(0).max(100),
    gpa_points: z.coerce.number().min(0).max(4.5).nullable(),
  })
  .refine((v) => v.min <= v.max, {
    message: "Minimum must not exceed maximum.",
    path: ["min"],
  });

export type GradeBoundaryRow = z.infer<typeof gradeBoundaryRowSchema>;

export const gradingSchemeSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(100),
  scheme_type: z.enum(GRADING_SCHEME_TYPES),
  grade_boundaries: z.array(gradeBoundaryRowSchema).min(1, "Add at least one grade boundary."),
});

export type GradingSchemeValues = z.infer<typeof gradingSchemeSchema>;

export const timetableSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(200),
  periods_per_day: z.coerce.number().int().min(1, "Enter at least 1 period.").max(20),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1, "Select at least one day."),
});

export type TimetableValues = z.infer<typeof timetableSchema>;

export const staffInviteBatchSchema = z.object({
  role: z.enum(STAFF_INVITE_ROLES),
  emails: z.array(z.email()).min(1, "Add at least one email."),
});

export type StaffInviteBatch = z.infer<typeof staffInviteBatchSchema>;

/** Splits a newline/comma-separated block of addresses into a de-duplicated, trimmed list. */
export function parseEmailList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

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
