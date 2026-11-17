import { z } from "@hono/zod-openapi";

import { revenueShareTotalsSchema } from "./revenue-share-schemas";
import { licenseCommitmentSchema, licenseStatusSchema } from "./schemas";

/**
 * OpenAPI schemas for the Student AI dashboards (phase 6, ./ai-dashboard.ts). As in the other
 * programme schemas: every nested object has its own `.openapi("Name")`, a nullable enum stays
 * inline, and no optional or nullable reference carries a description (the Dart client generator).
 */

const uuid = z.string().uuid();
const int = z.number().int();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const tierSchema = z.object({ fromBps: int, shareBps: int }).openapi("AiProgrammeDashboardTier");

export const dashboardLicenceSchema = z
  .object({
    id: uuid,
    status: licenseStatusSchema,
    commitment: licenseCommitmentSchema,
    startsOn: day,
    endsOn: day,
    studentSeats: int,
    currencyCode: z.string(),
    minorUnit: int,
    inProgramme: z.boolean(),
  })
  .openapi("AiProgrammeDashboardLicence");

export const dashboardYearSchema = z
  .object({ id: uuid, name: z.string(), startsOn: day, endsOn: day, months: int })
  .openapi("AiProgrammeDashboardYear");

export const dashboardValuesSchema = z
  .object({
    licensePriceMinor: int.nullable(),
    parentPriceMinor: int.nullable(),
    maxShareBps: int,
    conversionTiers: z.array(tierSchema),
    contentBonusTiers: z.array(tierSchema),
    largeSchoolMinSeats: int,
    largeSchoolShareBps: int,
    bonusRequiresConversionShare: z.boolean(),
    monthToMonthShareBps: int,
    measurementOffsetDays: int,
    payoutMode: z.enum(["invoice_credit", "payout"]),
  })
  .openapi("AiProgrammeDashboardValues");

export const dashboardStudentsSchema = z
  .object({ enrolled: int, optedIn: int, conversionBps: int })
  .openapi("AiProgrammeDashboardStudents");

export const dashboardConversionSchema = z
  .object({
    periodStart: day,
    measureOn: day,
    source: z.enum(["locked", "provisional", "live"]),
    enrolled: int,
    optedIn: int,
    conversionBps: int,
    seats: int,
    tierFromBps: int.nullable(),
    shareBps: int,
    floorApplied: z.boolean(),
  })
  .openapi("AiProgrammeDashboardConversion");

export const dashboardNextTierSchema = z
  .object({ fromBps: int, shareBps: int, optInsNeeded: int })
  .openapi("AiProgrammeDashboardNextTier");

export const dashboardFloorSchema = z
  .object({ minSeats: int, shareBps: int, seatsNeeded: int })
  .openapi("AiProgrammeDashboardFloor");

export const dashboardUploadsSchema = z
  .object({
    from: day,
    to: day,
    schoolDays: int,
    classesCounted: int,
    consistencyBps: int.nullable(),
    tierFromBps: int.nullable(),
    tierBonusBps: int,
    aimBps: int.nullable(),
  })
  .openapi("AiProgrammeDashboardUploads");

export const dashboardRateSchema = z
  .object({
    conversionShareBps: int,
    bonusBps: int,
    capped: z.boolean(),
    multiplierBps: int,
    totalBps: int,
  })
  .openapi("AiProgrammeDashboardRate");

export const dashboardShareSchema = z
  .object({
    collectedMinor: int,
    earnedMinor: int,
    pendingMinor: int,
    owedMinor: int,
    creditedMinor: int,
    payoutDueMinor: int,
    paidOutMinor: int,
    forfeitedMinor: int,
  })
  .openapi("AiProgrammeDashboardShare");

export const dashboardMarginSchema = z
  .object({
    basis: z.enum(["collected", "estimated", "mixed", "none"]),
    autoBilling: z.boolean(),
    perStudentMonthMinor: int.nullable(),
    lines: int,
    billedMinor: int,
    collectedMinor: int,
    estimatedMinor: int,
    expectedMinor: int,
  })
  .openapi("AiProgrammeDashboardMargin");

export const dashboardEarningsSchema = z
  .object({
    share: dashboardShareSchema,
    margin: dashboardMarginSchema,
    totalMinor: int,
    estimated: z.boolean(),
  })
  .openapi("AiProgrammeDashboardEarnings");

export const dashboardStudafySchema = z
  .object({
    invoicedMinor: int,
    paidMinor: int,
    outstandingMinor: int,
    overdueMinor: int,
    sharesCreditedMinor: int,
  })
  .openapi("AiProgrammeDashboardStudafy");

const dashboardShape = {
  schoolId: uuid,
  today: day,
  license: dashboardLicenceSchema.nullable(),
  academicYear: dashboardYearSchema.nullable(),
  currencyCode: z.string(),
  minorUnit: int,
  values: dashboardValuesSchema,
  students: dashboardStudentsSchema,
  conversion: dashboardConversionSchema.nullable(),
  nextTier: dashboardNextTierSchema.nullable(),
  largeSchoolFloor: dashboardFloorSchema.nullable(),
  uploads: dashboardUploadsSchema.nullable(),
  rate: dashboardRateSchema.nullable(),
  ledger: revenueShareTotalsSchema.nullable(),
  earnings: dashboardEarningsSchema,
  studafy: dashboardStudafySchema.nullable(),
};

export const aiProgrammeDashboardSchema = z.object(dashboardShape).openapi("AiProgrammeDashboard");

export const studafyNetSchema = z
  .object({ netMinor: int, perSeatMinor: int.nullable(), seats: int })
  .openapi("AiProgrammeStudafyNet");

export const platformAiProgrammeDashboardSchema = z
  .object({ ...dashboardShape, schoolName: z.string(), studafyNet: studafyNetSchema })
  .openapi("PlatformAiProgrammeDashboard");

export const aiProgrammeSchoolRowSchema = z
  .object({
    schoolId: uuid,
    schoolName: z.string(),
    licenseId: uuid.nullable(),
    licenseStatus: z
      .enum(["draft", "awaiting_payment", "active", "suspended", "expired", "cancelled"])
      .nullable(),
    commitment: z.enum(["full_year", "month_to_month"]).nullable(),
    inProgramme: z.boolean(),
    studentSeats: int,
    currencyCode: z.string(),
    minorUnit: int,
    enrolled: int,
    optedIn: int,
    liveConversionBps: int,
    conversionBps: int.nullable(),
    conversionSource: z.enum(["locked", "provisional", "live"]).nullable(),
    conversionShareBps: int,
    uploadConsistencyBps: int.nullable(),
    bonusBps: int,
    totalBps: int,
    collectedMinor: int,
    pendingMinor: int,
    owedMinor: int,
    creditedMinor: int,
    payoutDueMinor: int,
    paidOutMinor: int,
    forfeitedMinor: int,
    earnedMinor: int,
    studafyNetMinor: int,
    studafyNetPerSeatMinor: int.nullable(),
  })
  .openapi("AiProgrammeSchoolRow");

export const aiProgrammeSchoolListSchema = z
  .object({ schools: z.array(aiProgrammeSchoolRowSchema) })
  .openapi("AiProgrammeSchoolList");
