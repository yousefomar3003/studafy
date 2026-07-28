import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

const localeEnum = z.enum(["en", "fr", "ar", "es", "pt", "de"]).openapi({
  description: "ISO 639-1 locale code for the school's default language.",
  example: "en",
});

const timezoneSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[A-Za-z]+\/[A-Za-z_]+$/, "Must be a valid IANA timezone (e.g. Africa/Casablanca).")
  .openapi({
    description: "IANA timezone identifier used for timetable rendering and scheduling.",
    example: "Africa/Casablanca",
  });

const gradingSchemeEnum = z.enum(["letter", "percentage", "gpa", "numeric", "pass_fail"]).openapi({
  description: "Grading scheme used across the school's academic records.",
  example: "letter",
});

const invitationExpiryDaysSchema = z.number().int().min(1).max(365).openapi({
  description: "Number of days before an unused invitation expires.",
  example: 7,
});

const attendanceThresholdSchema = z.number().min(0).max(100).openapi({
  description: "Percentage threshold (0-100).",
  example: 75,
});

// ---------------------------------------------------------------------------
// Request (PATCH body)
// ---------------------------------------------------------------------------

export const updateSchoolSettingsBodySchema = z
  .object({
    locale: localeEnum.optional().openapi({ description: "Default locale for the school." }),
    timezone: timezoneSchema.optional().openapi({ description: "IANA timezone." }),
    grading_scheme: gradingSchemeEnum.optional().openapi({ description: "Grading scheme." }),
    invitation_expiry_days: invitationExpiryDaysSchema.optional().openapi({
      description: "Invitation validity in days.",
    }),
    attendance_alert_threshold: attendanceThresholdSchema.optional().openapi({
      description: "Attendance percentage at which an alert fires.",
    }),
    absence_alert_threshold: attendanceThresholdSchema.optional().openapi({
      description: "Absence percentage at which an alert fires.",
    }),
    parent_discipline_visibility: z.boolean().optional().openapi({
      description: "When true, parents can view their own child's resolved discipline incidents.",
      example: false,
    }),
  })
  .strict()
  .openapi("UpdateSchoolSettings");

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const schoolSettingsResponseSchema = z
  .object({
    locale: localeEnum.openapi({ description: "School locale." }),
    timezone: timezoneSchema.openapi({ description: "IANA timezone." }),
    grading_scheme: gradingSchemeEnum.openapi({ description: "Grading scheme." }),
    invitation_expiry_days: z.number().int().openapi({ description: "Invitation expiry (days)." }),
    attendance_alert_threshold: z.number().openapi({
      description: "Attendance alert threshold (%).",
    }),
    absence_alert_threshold: z.number().openapi({ description: "Absence alert threshold (%)." }),
    parent_discipline_visibility: z.boolean().openapi({
      description: "When true, parents can view their own child's resolved discipline incidents.",
      example: false,
    }),
    created_at: z
      .string()
      .datetime()
      .openapi({ description: "Row creation timestamp (ISO 8601)." }),
    updated_at: z
      .string()
      .datetime()
      .openapi({ description: "Last modification timestamp (ISO 8601)." }),
  })
  .openapi("SchoolSettings");
