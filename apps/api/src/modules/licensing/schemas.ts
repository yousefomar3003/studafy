import { z } from "@hono/zod-openapi";
import { FEATURE_KEYS, FEATURE_USAGE_UNITS } from "@studafy/constants";

import { AUDIENCES, LICENSE_STATUSES, MAX_ASSIGN_USER_IDS } from "./service";

/**
 * OpenAPI schemas for school licenses and seats. Every nested object carries its own
 * `.openapi("Name")`: the Dart client generator collides on inline names.
 */

export const audienceSchema = z.enum(AUDIENCES).openapi("LicenseAudience");
export const licenseStatusSchema = z.enum(LICENSE_STATUSES).openapi("LicenseStatus");

const uuid = z.string().uuid();

// ---------------------------------------------------------------------------------------------------
// Parameters and queries
// ---------------------------------------------------------------------------------------------------

export const platformSchoolParamsSchema = z.object({
  schoolId: uuid.openapi({ param: { name: "schoolId", in: "path" } }),
});

export const platformLicenseParamsSchema = platformSchoolParamsSchema.extend({
  licenseId: uuid.openapi({ param: { name: "licenseId", in: "path" } }),
});

export const platformSeatParamsSchema = platformLicenseParamsSchema.extend({
  seatId: uuid.openapi({ param: { name: "seatId", in: "path" } }),
});

export const platformRequestParamsSchema = platformSchoolParamsSchema.extend({
  requestId: uuid.openapi({ param: { name: "requestId", in: "path" } }),
});

export const schoolSeatParamsSchema = z.object({
  seatId: uuid.openapi({ param: { name: "seatId", in: "path" } }),
});

const limit = z.coerce.number().int().min(1).max(200).default(50);
const offset = z.coerce.number().int().min(0).default(0);

// Query-parameter enums are named too: the Dart generator numbers unnamed `status` parameters
// (Status16, Status17, ...) across the whole document, so an unnamed one renumbers every other
// screen's enum. A named enum must also appear in a response body, or the generator emits no model
// for it -- hence the seat list echoes the filter it applied.
const seatStatusFilterSchema = z
  .enum(["active", "unassigned", "all"])
  .openapi("LicenseSeatStatusFilter");
const changeRequestStatusSchema = z
  .enum(["open", "resolved", "declined"])
  .openapi("LicenseChangeRequestStatus");

export const seatListQuerySchema = z.object({
  audience: audienceSchema.optional(),
  status: seatStatusFilterSchema.default("active"),
  search: z.string().trim().max(100).optional(),
  limit,
  offset,
});

export const eligibleQuerySchema = z.object({
  audience: audienceSchema,
  gradeLevelId: uuid.optional(),
  sectionId: uuid.optional(),
  classId: uuid.optional(),
  search: z.string().trim().max(100).optional(),
  limit,
  offset,
});

export const changeRequestListQuerySchema = z.object({
  status: changeRequestStatusSchema.optional(),
});

// ---------------------------------------------------------------------------------------------------
// Licenses
// ---------------------------------------------------------------------------------------------------

const tierRefSchema = z
  .object({ id: uuid, code: z.string(), displayName: z.string() })
  .openapi("LicenseTierRef");

const audienceSeatsSchema = z
  .object({
    audience: audienceSchema,
    tier: tierRefSchema.nullable(),
    purchased: z.number().int().nonnegative(),
    assigned: z.number().int().nonnegative(),
  })
  .openapi("LicenseAudienceSeats");

export const licenseSchema = z
  .object({
    id: uuid,
    status: licenseStatusSchema,
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    includeFamilyPlus: z.boolean(),
    currencyCode: z.string(),
    activatedAt: z.string().datetime().nullable(),
    audiences: z.array(audienceSeatsSchema),
  })
  .openapi("SchoolLicense");

export const platformLicenseSchema = licenseSchema
  .extend({
    schoolId: uuid,
    notes: z.string().nullable(),
    createdBy: uuid,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    allowedTransitions: z.array(licenseStatusSchema),
  })
  .openapi("PlatformSchoolLicense");

export const platformLicenseListSchema = z
  .object({ licenses: z.array(platformLicenseSchema) })
  .openapi("PlatformSchoolLicenseList");

const audienceInputSchema = z
  .object({
    planId: uuid.nullable(),
    seats: z.number().int().min(0).max(100_000),
  })
  .openapi("LicenseAudienceInput");

const audiencePatchSchema = z
  .object({
    planId: uuid.nullable().optional(),
    seats: z.number().int().min(0).max(100_000).optional(),
  })
  .openapi("LicenseAudiencePatch");

const notes = z.string().trim().min(1).max(2000).nullable();

export const createLicenseBodySchema = z
  .object({
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    includeFamilyPlus: z.boolean().default(false),
    student: audienceInputSchema.optional(),
    teacher: audienceInputSchema.optional(),
    parent: audienceInputSchema.optional(),
    notes: notes.optional(),
  })
  .openapi("CreateSchoolLicenseBody");

export const updateLicenseBodySchema = z
  .object({
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    includeFamilyPlus: z.boolean().optional(),
    student: audiencePatchSchema.optional(),
    teacher: audiencePatchSchema.optional(),
    parent: audiencePatchSchema.optional(),
    notes: notes.optional(),
  })
  .openapi("UpdateSchoolLicenseBody");

export const licenseStatusBodySchema = z
  .object({
    status: z.enum(["awaiting_payment", "draft", "active", "suspended", "cancelled"]),
  })
  .openapi("SchoolLicenseStatusBody");

export const extendLicenseBodySchema = z
  .object({ endsAt: z.string().datetime() })
  .openapi("ExtendSchoolLicenseBody");

const renewalOutcomeSchema = z
  .object({
    overlapId: uuid,
    status: z.enum(["done", "failed"]),
    error: z.string().optional(),
  })
  .openapi("LicenseRenewalStopOutcome");

export const platformLicenseChangeResponseSchema = z
  .object({
    license: platformLicenseSchema,
    renewalStops: z.array(renewalOutcomeSchema),
  })
  .openapi("PlatformSchoolLicenseChange");

// ---------------------------------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------------------------------

const seatOverlapSchema = z
  .object({
    provider: z.string().nullable(),
    overlapDays: z.number().int().nonnegative(),
    creditMinor: z.number().int().nullable(),
    renewalAction: z.string(),
    renewalStatus: z.string(),
  })
  .openapi("LicenseSeatOverlap");

const seatSchema = z
  .object({
    seatId: uuid,
    audience: audienceSchema,
    userId: uuid,
    studentId: uuid.nullable(),
    name: z.string(),
    email: z.string(),
    assignedAt: z.string().datetime(),
    assignedByPlatform: z.boolean(),
    unassignedAt: z.string().datetime().nullable(),
    overlap: seatOverlapSchema.nullable(),
  })
  .openapi("LicenseSeat");

export const seatListSchema = z
  .object({
    seats: z.array(seatSchema),
    total: z.number().int().nonnegative(),
    /** The status filter applied. */
    status: seatStatusFilterSchema,
  })
  .openapi("LicenseSeatList");

const scopeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("all") }).openapi("LicenseSeatScopeAll"),
    z.object({ kind: z.literal("grade"), gradeLevelId: uuid }).openapi("LicenseSeatScopeGrade"),
    z.object({ kind: z.literal("section"), sectionId: uuid }).openapi("LicenseSeatScopeSection"),
    z.object({ kind: z.literal("class"), classId: uuid }).openapi("LicenseSeatScopeClass"),
  ])
  .openapi("LicenseSeatScope");

export const assignSeatsBodySchema = z
  .object({
    audience: audienceSchema,
    userIds: z.array(uuid).min(1).max(MAX_ASSIGN_USER_IDS).optional(),
    scope: scopeSchema.optional(),
  })
  .refine((body) => (body.userIds === undefined) !== (body.scope === undefined), {
    message: "Send exactly one of userIds or scope",
  })
  .openapi("AssignLicenseSeatsBody");

const assignedSeatSchema = z
  .object({ seatId: uuid, userId: uuid, name: z.string() })
  .openapi("AssignedLicenseSeat");

const notAssignedSchema = z
  .object({
    userId: uuid,
    name: z.string().nullable(),
    reason: z.enum(["already_assigned", "not_eligible", "no_seats_left"]),
  })
  .openapi("NotAssignedLicenseSeat");

export const assignSeatsResponseSchema = z
  .object({
    assigned: z.array(assignedSeatSchema),
    notAssigned: z.array(notAssignedSchema),
    renewalStops: z.array(renewalOutcomeSchema),
  })
  .openapi("AssignLicenseSeatsResult");

export const unassignSeatResponseSchema = z
  .object({ seatId: uuid, userId: uuid })
  .openapi("UnassignLicenseSeatResult");

const eligiblePersonSchema = z
  .object({
    userId: uuid,
    studentId: uuid.nullable(),
    name: z.string(),
    email: z.string(),
    hasPersonalSubscription: z.boolean(),
  })
  .openapi("LicenseEligiblePerson");

export const eligibleListSchema = z
  .object({ people: z.array(eligiblePersonSchema), total: z.number().int().nonnegative() })
  .openapi("LicenseEligibleList");

// ---------------------------------------------------------------------------------------------------
// The school's view, usage and change requests
// ---------------------------------------------------------------------------------------------------

const featureUsageSchema = z
  .object({
    feature: z.enum(FEATURE_KEYS as [string, ...string[]]),
    unit: z.enum(FEATURE_USAGE_UNITS).nullable(),
    used: z.number().int().nonnegative(),
  })
  .openapi("LicenseFeatureUsage");

export const changeRequestSchema = z
  .object({
    id: uuid,
    licenseId: uuid.nullable(),
    studentSeats: z.number().int().nullable(),
    teacherSeats: z.number().int().nullable(),
    parentSeats: z.number().int().nullable(),
    includeFamilyPlus: z.boolean().nullable(),
    note: z.string(),
    status: changeRequestStatusSchema,
    requestedBy: uuid,
    createdAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    resolutionNote: z.string().nullable(),
  })
  .openapi("LicenseChangeRequest");

export const changeRequestListSchema = z
  .object({ requests: z.array(changeRequestSchema) })
  .openapi("LicenseChangeRequestList");

export const schoolLicenseOverviewSchema = z
  .object({
    license: licenseSchema.nullable(),
    usage: z.array(featureUsageSchema).openapi({
      description: "This calendar month's (UTC) units per feature, over the current seat holders.",
    }),
    openChangeRequests: z.array(changeRequestSchema),
  })
  .openapi("SchoolLicenseOverview");

const seatCount = z.number().int().min(0).max(100_000).nullable().optional();

export const createChangeRequestBodySchema = z
  .object({
    studentSeats: seatCount,
    teacherSeats: seatCount,
    parentSeats: seatCount,
    includeFamilyPlus: z.boolean().nullable().optional(),
    note: z.string().trim().min(1).max(2000),
  })
  .openapi("CreateLicenseChangeRequestBody");

export const resolveChangeRequestBodySchema = z
  .object({
    status: z.enum(["resolved", "declined"]),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .openapi("ResolveLicenseChangeRequestBody");
