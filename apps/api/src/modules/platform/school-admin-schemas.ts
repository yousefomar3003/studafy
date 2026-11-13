import { z } from "@hono/zod-openapi";

import { localeEnum, timezoneSchema } from "../tenancy/settings/schemas";

/**
 * Contracts for the platform console's per-school administration: editing a school's profile,
 * its usage panel, and whole-school data exports (`/api/platform/schools/{schoolId}/...`).
 * camelCase, like the rest of the platform console.
 */

const isoDateTime = z.string().datetime();

/** Why -- recorded in both audit rows. Every console write names one. */
const reasonSchema = z.string().trim().min(3).max(500);

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const updateSchoolProfileBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    /** The school's contact email; unique across schools (uq_schools_normalized_email). */
    email: z.string().trim().email().max(320).optional(),
    /** ISO 3166-1 alpha-2, an active row of app.countries. */
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "Must be a two-letter country code.")
      .optional(),
    /** ISO 4217, an active row of app.currencies. */
    currencyCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "Must be a three-letter currency code.")
      .optional(),
    /** The school's default language -- the same values School settings accepts. */
    locale: localeEnum.optional(),
    /** IANA timezone -- the same rule School settings applies. */
    timezone: timezoneSchema.optional(),
    reason: reasonSchema,
  })
  .strict()
  .refine(
    (body) =>
      [body.name, body.email, body.countryCode, body.currencyCode, body.locale, body.timezone].some(
        (value) => value !== undefined,
      ),
    { message: "Change at least one field.", path: ["name"] },
  )
  .openapi("UpdatePlatformSchoolProfile");

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const schoolUsageSchema = z
  .object({
    /** Accounts per role: signed up and active, and created but not yet activated. */
    people: z.array(
      z.object({
        role: z.string(),
        active: z.number().int().nonnegative(),
        invited: z.number().int().nonnegative(),
      }),
    ),
    /** Invitations sent and still open (not used, revoked or expired). */
    pendingInvitations: z.number().int().nonnegative(),
    storage: z.object({
      bytesUsed: z.number().int().nonnegative(),
      capBytes: z.number().int().nonnegative(),
      /** 0..1; null when the cap is zero. */
      fractionUsed: z.number().nonnegative().nullable(),
    }),
    ai: z.object({
      /** Students with a live AI add-on. */
      activeSubscriptions: z.number().int().nonnegative(),
      /** Tokens metered on the live AI add-ons (app.ai_usage_meters), this billing period. */
      tokensThisPeriod: z.number().int().nonnegative(),
      /** First day (UTC) of the calendar month `featureUses` counts. */
      monthStart: z.string().date(),
      /** Units of each licensed feature used this calendar month (app.feature_usage_meters). */
      featureUses: z.array(
        z.object({ featureKey: z.string(), used: z.number().int().nonnegative() }),
      ),
    }),
    activity: z.object({
      lastActivityAt: isoDateTime.nullable(),
      /** Users who signed in during the last 30 days. */
      activeUsersLast30Days: z.number().int().nonnegative(),
    }),
    /** The school's active licence and its seats, or null when it has none in force. */
    license: z
      .object({
        id: z.string().uuid(),
        startsAt: isoDateTime,
        endsAt: isoDateTime,
        seats: z.array(
          z.object({
            audience: z.enum(["student", "teacher", "parent"]),
            bought: z.number().int().nonnegative(),
            used: z.number().int().nonnegative(),
          }),
        ),
      })
      .nullable(),
    generatedAt: isoDateTime,
  })
  .openapi("PlatformSchoolUsage");

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const createSchoolExportBodySchema = z
  .object({ reason: reasonSchema })
  .strict()
  .openapi("CreatePlatformSchoolExport");

export const schoolExportSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["queued", "processing", "completed", "failed"]),
    createdAt: isoDateTime,
    completedAt: isoDateTime.nullable(),
    failureMessage: z.string().nullable(),
    /** When the retention sweep deletes the bundle (30 days after completion). */
    expiresAt: isoDateTime.nullable(),
    /** Set once the retention sweep has deleted the bundle; no link after that. */
    deletedAt: isoDateTime.nullable(),
    /** A short-lived signed link; only on the single-export read of a completed, kept bundle. */
    downloadUrl: z.string().url().nullable(),
    downloadUrlExpiresAt: isoDateTime.nullable(),
  })
  .openapi("PlatformSchoolExport");

export const schoolExportListSchema = z
  .object({ exports: z.array(schoolExportSchema) })
  .openapi("PlatformSchoolExportList");

export const schoolExportParamSchema = z.object({
  schoolId: z
    .string()
    .uuid()
    .openapi({ param: { name: "schoolId", in: "path" } }),
  exportId: z
    .string()
    .uuid()
    .openapi({ param: { name: "exportId", in: "path" } }),
});
