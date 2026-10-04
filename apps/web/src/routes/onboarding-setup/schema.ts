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

/** ISO weekday numbers (1 = Monday); `labelKey` is translated where the checkbox renders. */
export const WEEKDAYS = [
  { value: 1, labelKey: "onboarding.setup.weekdays.mon" },
  { value: 2, labelKey: "onboarding.setup.weekdays.tue" },
  { value: 3, labelKey: "onboarding.setup.weekdays.wed" },
  { value: 4, labelKey: "onboarding.setup.weekdays.thu" },
  { value: 5, labelKey: "onboarding.setup.weekdays.fri" },
  { value: 6, labelKey: "onboarding.setup.weekdays.sat" },
  { value: 7, labelKey: "onboarding.setup.weekdays.sun" },
] as const;

// Mirrors apps/api/src/modules/tenancy/settings/schemas.ts's `timezoneSchema` exactly.
const TIMEZONE_PATTERN = /^[A-Za-z]+\/[A-Za-z_]+$/;

// Validation messages are translation keys (`onboarding.setup.validation.*`), not display text —
// these schemas are built at module load, before any locale is known, so each step translates the
// message with `t()` where it renders it.
const TOO_LONG = "onboarding.setup.validation.tooLong";
const INVALID_VALUE = "onboarding.setup.validation.invalid";
const PERCENT_RANGE = "onboarding.setup.validation.percentRange";

export const schoolProfileSchema = z.object({
  locale: z.enum(LOCALE_OPTIONS),
  timezone: z.string().trim().regex(TIMEZONE_PATTERN, "onboarding.setup.validation.timezone"),
  invitation_expiry_days: z.coerce
    .number()
    .int(INVALID_VALUE)
    .min(1, "onboarding.setup.validation.expiryDaysRange")
    .max(365, "onboarding.setup.validation.expiryDaysRange"),
  attendance_alert_threshold: z.coerce.number().min(0, PERCENT_RANGE).max(100, PERCENT_RANGE),
  absence_alert_threshold: z.coerce.number().min(0, PERCENT_RANGE).max(100, PERCENT_RANGE),
  parent_discipline_visibility: z.boolean(),
  attendance_correction_window_hours: z.coerce
    .number()
    .int(INVALID_VALUE)
    .min(1, "onboarding.setup.validation.correctionWindowRange")
    .max(8760, "onboarding.setup.validation.correctionWindowRange"),
});

export type SchoolProfileValues = z.infer<typeof schoolProfileSchema>;

export const academicYearSchema = z
  .object({
    code: z.string().trim().min(1, "onboarding.setup.validation.codeRequired").max(50, TOO_LONG),
    name: z.string().trim().min(1, "onboarding.setup.validation.nameRequired").max(200, TOO_LONG),
    starts_on: z.string().date("onboarding.setup.validation.startDateInvalid"),
    ends_on: z.string().date("onboarding.setup.validation.endDateInvalid"),
  })
  .refine((v) => v.starts_on < v.ends_on, {
    message: "onboarding.setup.validation.endBeforeStart",
    path: ["ends_on"],
  });

export type AcademicYearValues = z.infer<typeof academicYearSchema>;

export const gradeBoundaryRowSchema = z
  .object({
    label: z.string().trim().min(1, "onboarding.setup.validation.labelRequired"),
    min: z.coerce.number().min(0, PERCENT_RANGE).max(100, PERCENT_RANGE),
    max: z.coerce.number().min(0, PERCENT_RANGE).max(100, PERCENT_RANGE),
    gpa_points: z.coerce
      .number()
      .min(0, "onboarding.setup.validation.gpaRange")
      .max(4.5, "onboarding.setup.validation.gpaRange")
      .nullable(),
  })
  .refine((v) => v.min <= v.max, {
    message: "onboarding.setup.validation.minAboveMax",
    path: ["min"],
  });

export type GradeBoundaryRow = z.infer<typeof gradeBoundaryRowSchema>;

export const gradingSchemeSchema = z.object({
  name: z.string().trim().min(1, "onboarding.setup.validation.nameRequired").max(100, TOO_LONG),
  scheme_type: z.enum(GRADING_SCHEME_TYPES),
  grade_boundaries: z
    .array(gradeBoundaryRowSchema)
    .min(1, "onboarding.setup.validation.boundaryRequired"),
});

export type GradingSchemeValues = z.infer<typeof gradingSchemeSchema>;

export const timetableSchema = z.object({
  name: z.string().trim().min(1, "onboarding.setup.validation.nameRequired").max(200, TOO_LONG),
  periods_per_day: z.coerce
    .number()
    .int(INVALID_VALUE)
    .min(1, "onboarding.setup.validation.periodsMin")
    .max(20, "onboarding.setup.validation.periodsMax"),
  weekdays: z
    .array(z.number().int().min(1).max(7))
    .min(1, "onboarding.setup.validation.weekdayRequired"),
});

export type TimetableValues = z.infer<typeof timetableSchema>;

export const staffInviteBatchSchema = z.object({
  role: z.enum(STAFF_INVITE_ROLES),
  emails: z
    .array(z.email("onboarding.setup.validation.emailInvalid"))
    .min(1, "onboarding.setup.validation.emailRequired"),
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

/**
 * First validation message per top-level field, for rendering against `Input`/`Select` `error`
 * props. Values are translation keys — pass each through `t()` where it is displayed. An issue
 * without a schema-supplied key (a Zod default message) falls back to a generic "invalid" key so
 * raw English never reaches a translated screen.
 */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");
    if (field && !(field in errors)) {
      // eslint-disable-next-line security/detect-object-injection -- `field` comes from this module's own Zod schema issues, and `errors` is a fresh local object, not a shared/prototype-bearing one
      errors[field] = issue.message.startsWith("onboarding.") ? issue.message : INVALID_VALUE;
    }
  }
  return errors;
}
