import { z } from "@hono/zod-openapi";
import { AI_OPTIN_SOURCES, AI_OPTIN_STATUSES } from "@studafy/license-pricing";

import { licenseCommitmentSchema, licenseStatusSchema } from "./schemas";

/**
 * OpenAPI schemas for Student AI opt-in (000235). Every nested object and enum carries its own
 * `.openapi("Name")` (the Dart client generator collides on inline names), optional request fields
 * are `.optional()`, and nullable references carry no description.
 */

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const minor = z.number().int();
const note = z.string().trim().min(1).max(1000);

export const aiOptInSourceSchema = z.enum(AI_OPTIN_SOURCES).openapi("AiOptInSource");
export const aiOptInStatusSchema = z.enum(AI_OPTIN_STATUSES).openapi("AiOptInStatus");

const personRefSchema = z.object({ userId: uuid, name: z.string() }).openapi("AiOptInPerson");

const academicYearRefSchema = z
  .object({ id: uuid, name: z.string(), startsOn: date, endsOn: date })
  .openapi("AiOptInAcademicYear");

const scopeRefSchema = z.object({ id: uuid, name: z.string() }).openapi("AiOptInScopeRef");

export const aiOptInWindowSchema = z
  .object({
    id: uuid,
    licenseId: uuid,
    academicYear: academicYearRefSchema,
    opensOn: date,
    closesOn: date,
    state: z.enum(["scheduled", "open", "ended", "closed"]).openapi("AiOptInWindowState"),
    note: z.string().nullable(),
    gradeLevels: z.array(scopeRefSchema),
    sections: z.array(scopeRefSchema),
    openedBy: personRefSchema,
    openedAt: z.string().datetime(),
    closedBy: personRefSchema.nullable(),
    closedAt: z.string().datetime().nullable(),
  })
  .openapi("AiOptInWindow");

export const aiOptInSchema = z
  .object({
    id: uuid,
    studentId: uuid,
    studentName: z.string(),
    academicYearId: uuid,
    licenseId: uuid,
    windowId: uuid.nullable(),
    source: aiOptInSourceSchema,
    parent: personRefSchema.nullable(),
    recordedBy: personRefSchema,
    note: z.string().nullable(),
    termsVersion: z.string(),
    optedInAt: z.string().datetime(),
    startMonth: date,
    endMonth: date,
    months: z.number().int(),
    currencyCode: z.string(),
    minorUnit: z.number().int(),
    monthlyPriceMinor: minor,
    totalMinor: minor,
    seatId: uuid.nullable(),
    seatAssignedAt: z.string().datetime().nullable(),
    status: aiOptInStatusSchema,
    endedAt: z.string().datetime().nullable(),
    endNote: z.string().nullable(),
    releasedEffectiveMonth: date.nullable(),
    transferredToId: uuid.nullable(),
    transferredFromId: uuid.nullable(),
  })
  .openapi("AiOptIn");

// ---------------------------------------------------------------------------------------------------
// School
// ---------------------------------------------------------------------------------------------------

const overviewLicenseSchema = z
  .object({
    id: uuid,
    status: licenseStatusSchema,
    studentSeats: z.number().int(),
    assignedStudentSeats: z.number().int(),
    commitment: licenseCommitmentSchema,
  })
  .openapi("AiOptInOverviewLicense");

const overviewProgrammeSchema = z
  .object({
    currencyCode: z.string(),
    minorUnit: z.number().int(),
    monthlyPriceMinor: minor.nullable(),
    minSeats: z.number().int(),
  })
  .openapi("AiOptInOverviewProgramme");

const pricingTodaySchema = z
  .object({ startMonth: date, endMonth: date, months: z.number().int(), totalMinor: minor })
  .openapi("AiOptInPricingToday");

const overviewCountsSchema = z
  .object({
    eligible: z.number().int(),
    optedIn: z.number().int(),
    waitingForSeat: z.number().int(),
    released: z.number().int(),
    transferred: z.number().int(),
  })
  .openapi("AiOptInCounts");

const seatRequestRefSchema = z
  .object({ id: uuid, studentSeats: z.number().int().nullable(), createdAt: z.string().datetime() })
  .openapi("AiOptInSeatRequest");

export const schoolAiOptInOverviewSchema = z
  .object({
    license: overviewLicenseSchema.nullable(),
    programme: overviewProgrammeSchema.nullable(),
    window: aiOptInWindowSchema.nullable(),
    pricingToday: pricingTodaySchema.nullable(),
    counts: overviewCountsSchema,
    seatsNeeded: z.number().int().openapi({
      description:
        "Seats the licence must have: the larger of the active opt-ins and the programme's minimum.",
    }),
    openSeatRequest: seatRequestRefSchema.nullable(),
    blocker: z
      .enum(["no_licence", "no_student_tier", "no_price", "no_academic_year"])
      .nullable()
      .openapi({ description: "Why a window cannot be opened now; null when it can." }),
    termsVersion: z.string(),
    today: date,
  })
  .openapi("SchoolAiOptInOverview");

export const openWindowBodySchema = z
  .object({
    academicYearId: uuid.optional().openapi({
      description: "Defaults to the current academic year.",
    }),
    opensOn: date,
    closesOn: date,
    gradeLevelIds: z.array(uuid).max(100).optional(),
    sectionIds: z.array(uuid).max(500).optional(),
    note: note.optional(),
    acknowledgeMinimumSeats: z.boolean().openapi({
      description:
        "The school accepts that it pays for the programme's minimum seats even if fewer students " +
        "opt in. Must be true (422 AI_OPTIN_MINIMUM_NOT_ACKNOWLEDGED).",
    }),
  })
  .openapi("OpenAiOptInWindowBody");

export const windowParamsSchema = z.object({
  windowId: uuid.openapi({ param: { name: "windowId", in: "path" } }),
});

export const optInParamsSchema = z.object({
  optInId: uuid.openapi({ param: { name: "optInId", in: "path" } }),
});

// Named and echoed in the response, for the Dart generator.
const studentFilterSchema = z
  .enum(["all", "opted_in", "not_opted_in", "waiting", "left_with_seat"])
  .openapi("AiOptInStudentFilter");

export const optInStudentsQuerySchema = z.object({
  filter: studentFilterSchema.default("all"),
  gradeLevelId: uuid.optional(),
  sectionId: uuid.optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const optInStudentRowSchema = z
  .object({
    studentId: uuid,
    name: z.string(),
    admissionNumber: z.string(),
    studentStatus: z.string(),
    gradeLevelName: z.string().nullable(),
    sectionName: z.string().nullable(),
    eligible: z.boolean(),
    optIn: aiOptInSchema.nullable(),
  })
  .openapi("AiOptInStudentRow");

export const optInStudentListSchema = z
  .object({
    students: z.array(optInStudentRowSchema),
    total: z.number().int(),
    filter: studentFilterSchema,
  })
  .openapi("AiOptInStudentList");

export const recordOnBehalfBodySchema = z
  .object({
    studentIds: z.array(uuid).max(500).optional(),
    admissionNumbers: z.array(z.string().trim().min(1).max(100)).max(2000).optional().openapi({
      description: "School-issued admission numbers, e.g. from a CSV column.",
    }),
    note: note.openapi({
      description:
        "Required: how the parent's choice reached the school (recorded on their behalf).",
    }),
  })
  .refine((body) => (body.studentIds?.length ?? 0) + (body.admissionNumbers?.length ?? 0) > 0, {
    message: "Name at least one student",
  })
  .openapi("RecordAiOptInsBody");

const notRecordedSchema = z
  .object({
    studentId: uuid.nullable(),
    reference: z.string(),
    reason: z
      .enum(["not_eligible", "already_opted_in", "not_found"])
      .openapi("AiOptInNotRecordedReason"),
  })
  .openapi("AiOptInNotRecorded");

export const recordResultSchema = z
  .object({ recorded: z.array(aiOptInSchema), notRecorded: z.array(notRecordedSchema) })
  .openapi("RecordAiOptInsResult");

export const transferBodySchema = z
  .object({ toStudentId: uuid, note })
  .openapi("TransferAiOptInBody");

export const transferResultSchema = z
  .object({ from: aiOptInSchema, to: aiOptInSchema })
  .openapi("TransferAiOptInResult");

export const releaseBodySchema = z.object({ note }).openapi("ReleaseAiOptInBody");

// ---------------------------------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------------------------------

const parentOfferWindowSchema = z
  .object({ id: uuid, opensOn: date, closesOn: date, academicYearName: z.string() })
  .openapi("ParentAiOfferWindow");

const parentOfferPricingSchema = z
  .object({
    currencyCode: z.string(),
    minorUnit: z.number().int(),
    monthlyPriceMinor: minor,
    months: z.number().int(),
    totalMinor: minor,
    startMonth: date,
    endMonth: date,
  })
  .openapi("ParentAiOfferPricing");

const parentOfferSchema = z
  .object({
    studentId: uuid,
    studentName: z.string(),
    state: z.enum(["available", "opted_in", "closed"]).openapi("ParentAiOfferState"),
    window: parentOfferWindowSchema.nullable(),
    pricing: parentOfferPricingSchema.nullable(),
    optIn: aiOptInSchema.nullable(),
  })
  .openapi("ParentAiOffer");

export const parentOffersSchema = z
  .object({ offers: z.array(parentOfferSchema), termsVersion: z.string() })
  .openapi("ParentAiOffers");

export const parentOptInBodySchema = z
  .object({
    studentId: uuid,
    acceptTerms: z.boolean().openapi({
      description:
        "The parent ticked the confirmation: committed for the school year, can't be cancelled " +
        "mid-year, paid with tuition. Must be true.",
    }),
    termsVersion: z.string().min(1).max(40),
    expectedTotalMinor: minor.openapi({
      description: "The total the parent was shown; 409 AI_OPTIN_PRICE_CHANGED when it changed.",
    }),
  })
  .openapi("ParentAiOptInBody");
