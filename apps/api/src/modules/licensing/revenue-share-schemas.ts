import { z } from "@hono/zod-openapi";
import { REVENUE_SHARE_STATUSES } from "@studafy/billing";
import { AI_PROGRAMME_LIMITS } from "@studafy/license-pricing";

import { licenseCommitmentSchema } from "./schemas";

/**
 * OpenAPI schemas for the Student AI revenue share (000237). As in billing-schemas.ts and
 * ai-programme-schemas.ts: every nested object and every enum has its own `.openapi("Name")`, a
 * nullable enum stays inline (a nullable reference to a named enum breaks the Dart client
 * generator), and no optional or nullable reference carries a description.
 */

const uuid = z.string().uuid();
const int = z.number().int();
const bps = int.openapi({ description: "Basis points: 10000 is 100%." });
const minor = int.openapi({ description: "Minor units of the currency (cents)." });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pathUuid = (name: string) => uuid.openapi({ param: { name, in: "path" } });

export const revenueShareSchoolParamsSchema = z.object({ schoolId: pathUuid("schoolId") });
export const revenueShareLicenseParamsSchema = z.object({
  schoolId: pathUuid("schoolId"),
  licenseId: pathUuid("licenseId"),
});

export const revenueShareStatusSchema = z
  .enum(REVENUE_SHARE_STATUSES)
  .openapi("AiRevenueShareStatus");
// The licence's own commitment (LicenseCommitment, 000235): one enum for the licence, the quote and
// the revenue share.
export const revenueShareCommitmentSchema = licenseCommitmentSchema;

export const revenueShareQuerySchema = z.object({
  licenseId: uuid.optional().openapi({ param: { name: "licenseId", in: "query" } }),
  status: revenueShareStatusSchema.optional().openapi({ param: { name: "status", in: "query" } }),
});
export const schoolRevenueShareQuerySchema = z.object({
  licenseId: uuid.optional().openapi({ param: { name: "licenseId", in: "query" } }),
});

export const revenueShareEntrySchema = z
  .object({
    id: uuid,
    kind: z.enum(["share", "reversal"]).openapi("AiRevenueShareEntryKind"),
    reversesEntryId: uuid.nullable(),
    licenseId: uuid,
    invoiceId: uuid,
    invoiceNumber: z.string(),
    paymentId: uuid,
    instalmentId: uuid,
    instalmentPosition: int,
    receivedOn: day,
    periodFrom: day,
    periodTo: day,
    measurementPeriodStart: day,
    currencyCode: z.string(),
    minorUnit: int,
    collectedMinor: minor,
    baseMinor: minor,
    commitment: revenueShareCommitmentSchema,
    programmeVersionId: uuid,
    programmeOverrideId: uuid.nullable(),
    seats: int.nullable(),
    conversionBps: int.nullable(),
    conversionShareBps: bps,
    floorApplied: z.boolean(),
    uploadConsistencyBps: int.nullable(),
    bonusBps: bps,
    capped: z.boolean(),
    multiplierBps: bps,
    totalBps: bps,
    amountMinor: minor,
    conversionPending: z.boolean(),
    bonusPending: z.boolean(),
    status: revenueShareStatusSchema,
    computedAt: z.string().datetime(),
    creditInvoiceId: uuid.nullable(),
    creditInvoiceNumber: z.string().nullable(),
    creditedAt: z.string().datetime().nullable(),
    payoutId: uuid.nullable(),
    forfeitedAt: z.string().datetime().nullable(),
    forfeitReason: z.enum(["late_payment", "unpaid_at_cutoff"]).nullable(),
    voidedAt: z.string().datetime().nullable(),
  })
  .openapi("AiRevenueShareEntry");

export const revenueShareTotalsSchema = z
  .object({
    currencyCode: z.string(),
    minorUnit: int,
    baseMinor: minor,
    pendingMinor: minor,
    owedMinor: minor,
    creditedMinor: minor,
    payoutDueMinor: minor,
    paidOutMinor: minor,
    forfeitedMinor: minor,
    earnedMinor: minor,
  })
  .openapi("AiRevenueShareTotals");

export const revenueSharePayoutSchema = z
  .object({
    id: uuid,
    currencyCode: z.string(),
    amountMinor: minor,
    reference: z.string(),
    paidOn: day,
    note: z.string().nullable(),
    recordedBy: uuid,
    createdAt: z.string().datetime(),
  })
  .openapi("AiRevenueSharePayout");

export const schoolRevenueShareSchema = z
  .object({
    totals: z.array(revenueShareTotalsSchema),
    entries: z.array(revenueShareEntrySchema),
    payouts: z.array(revenueSharePayoutSchema),
  })
  .openapi("AiRevenueShareLedger");

export const conversionSnapshotSchema = z
  .object({
    id: uuid,
    periodStart: day,
    measureOn: day,
    asOf: day,
    enrolledCount: int,
    optedInCount: int,
    conversionBps: bps,
    seats: int,
    conversionShareBps: bps,
    floorApplied: z.boolean(),
    locked: z.boolean(),
    source: z.enum(["scheduled", "super_admin"]).openapi("AiConversionSnapshotSource"),
    reason: z.string().nullable(),
    measuredBy: uuid.nullable(),
    measuredAt: z.string().datetime(),
  })
  .openapi("AiConversionSnapshot");

export const measurementPeriodSchema = z
  .object({
    periodStart: day,
    measureOn: day,
    locked: conversionSnapshotSchema.nullable(),
    measurements: z.array(conversionSnapshotSchema),
  })
  .openapi("AiConversionMeasurementPeriod");

export const revenueShareRateSchema = z
  .object({
    periodStart: day,
    conversionSource: z
      .enum(["locked", "provisional", "none"])
      .openapi("AiRevenueShareConversionSource"),
    conversionBps: int.nullable(),
    conversionShareBps: bps,
    floorApplied: z.boolean(),
    multiplierBps: bps,
    maxShareBps: bps,
    payoutMode: z.enum(["invoice_credit", "payout"]),
  })
  .openapi("AiRevenueShareRate");

export const licenseRevenueShareSchema = z
  .object({
    licenseId: uuid,
    currencyCode: z.string(),
    commitment: revenueShareCommitmentSchema,
    periods: z.array(measurementPeriodSchema),
    rate: revenueShareRateSchema,
    totals: z.array(revenueShareTotalsSchema),
    entries: z.array(revenueShareEntrySchema),
  })
  .openapi("AiLicenseRevenueShare");

export const remeasureBodySchema = z
  .object({
    reason: z.string().max(AI_PROGRAMME_LIMITS.reasonMaxLength),
    periodStart: day.nullable().optional(),
  })
  .openapi("AiConversionRemeasureBody");

export const recomputeResultSchema = z
  .object({
    resolved: int,
    settled: int,
    revenueShare: schoolRevenueShareSchema,
  })
  .openapi("AiRevenueShareRecomputeResult");

export const recordPayoutBodySchema = z
  .object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    amountMinor: minor,
    reference: z.string().trim().min(1).max(200),
    paidOn: day,
    note: z.string().max(1000).nullable().optional(),
  })
  .openapi("AiRevenueSharePayoutBody");
