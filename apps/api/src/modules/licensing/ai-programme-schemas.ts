import { z } from "@hono/zod-openapi";
import {
  AI_PROGRAMME_FIELDS,
  AI_PROGRAMME_LIMITS,
  AI_PROGRAMME_OVERRIDE_FIELDS,
  AI_PROGRAMME_PAYOUT_MODES,
} from "@studafy/license-pricing";

/**
 * OpenAPI schemas for the Student AI programme's settings (000234). As in billing-schemas.ts: every
 * nested object and every enum has its own `.openapi("Name")`, a nullable enum stays inline (a
 * nullable reference to a named enum breaks the Dart client generator), and no optional or nullable
 * reference carries a description.
 *
 * Shapes and types are checked here; the business rules (ranges, tier order, shares under the
 * maximum) are the service's, so a broken one answers its own coded error (AI_PROGRAMME_*) rather
 * than a generic VALIDATION_FAILED.
 */

const uuid = z.string().uuid();
const int = z.number().int();
const bps = int.openapi({ description: "Basis points: 10000 is 100%." });
const minor = int.openapi({ description: "Minor units of the currency (cents)." });
const reason = z.string().max(AI_PROGRAMME_LIMITS.reasonMaxLength);
const pathUuid = (name: string) => uuid.openapi({ param: { name, in: "path" } });

export const aiProgrammeSchoolParamsSchema = z.object({ schoolId: pathUuid("schoolId") });
export const aiProgrammeLicenseParamsSchema = z.object({
  schoolId: pathUuid("schoolId"),
  licenseId: pathUuid("licenseId"),
});

export const aiProgrammePayoutModeSchema = z
  .enum(AI_PROGRAMME_PAYOUT_MODES)
  .openapi("AiProgrammePayoutMode");
export const aiProgrammeOverrideFieldSchema = z
  .enum(AI_PROGRAMME_OVERRIDE_FIELDS)
  .openapi("AiProgrammeOverrideField");
export const aiProgrammeFieldSchema = z.enum(AI_PROGRAMME_FIELDS).openapi("AiProgrammeField");
export const aiProgrammeIssueCodeSchema = z
  .enum(["out_of_range", "tiers_invalid", "share_above_max", "currency_invalid"])
  .openapi("AiProgrammeIssueCode");

export const aiProgrammeTierSchema = z
  .object({
    fromBps: bps,
    shareBps: bps,
  })
  .openapi("AiProgrammeTier");

export const aiProgrammePriceSchema = z
  .object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    iapPriceMinor: minor,
    licensePriceMinor: minor,
    parentPriceMinor: minor,
  })
  .openapi("AiProgrammePrice");

const tiers = () => z.array(aiProgrammeTierSchema).max(AI_PROGRAMME_LIMITS.maxTiers);

const settingsShape = {
  prices: z.array(aiProgrammePriceSchema).max(AI_PROGRAMME_LIMITS.maxCurrencies),
  minSeats: int,
  maxShareBps: bps,
  conversionTiers: tiers(),
  largeSchoolMinSeats: int,
  largeSchoolShareBps: bps,
  contentBonusTiers: tiers(),
  bonusRequiresConversionShare: z.boolean(),
  measurementOffsetDays: int,
  nonpaymentGraceDays: int,
  monthToMonthShareBps: bps,
  payoutMode: aiProgrammePayoutModeSchema,
};

export const aiProgrammeSettingsSchema = z.object(settingsShape).openapi("AiProgrammeSettings");

export const aiProgrammeAuthorSchema = z
  .object({ userId: uuid.nullable(), name: z.string().nullable() })
  .openapi("AiProgrammeAuthor");

export const aiProgrammeVersionSchema = z
  .object({
    id: uuid,
    versionNumber: int,
    settings: aiProgrammeSettingsSchema,
    reason: z.string(),
    createdBy: aiProgrammeAuthorSchema,
    createdAt: z.string().datetime(),
  })
  .openapi("AiProgrammeVersion");

export const aiProgrammeCurrentSchema = z
  .object({ current: aiProgrammeVersionSchema })
  .openapi("AiProgrammeCurrent");

export const aiProgrammeVersionListSchema = z
  .object({ versions: z.array(aiProgrammeVersionSchema) })
  .openapi("AiProgrammeVersionList");

export const aiProgrammeVersionBodySchema = z
  .object({
    ...settingsShape,
    reason,
    basedOnVersionId: uuid.nullable().optional(),
  })
  .openapi("AiProgrammeVersionBody");

/** The override's fields; null inherits the global value. */
const overrideFieldsShape = {
  licensePriceMinor: minor.nullable(),
  parentPriceMinor: minor.nullable(),
  minSeats: int.nullable(),
  maxShareBps: bps.nullable(),
  conversionTiers: tiers().nullable(),
  largeSchoolMinSeats: int.nullable(),
  largeSchoolShareBps: bps.nullable(),
  contentBonusTiers: tiers().nullable(),
  bonusRequiresConversionShare: z.boolean().nullable(),
  measurementOffsetDays: int.nullable(),
  nonpaymentGraceDays: int.nullable(),
  monthToMonthShareBps: bps.nullable(),
  payoutMode: z.enum(AI_PROGRAMME_PAYOUT_MODES).nullable(),
};

export const aiProgrammeOverrideSchema = z
  .object({ priceCurrencyCode: z.string().nullable(), ...overrideFieldsShape })
  .openapi("AiProgrammeOverride");

export const aiProgrammeOverrideVersionSchema = z
  .object({
    id: uuid,
    schoolId: uuid,
    versionNumber: int,
    override: aiProgrammeOverrideSchema,
    empty: z.boolean(),
    reason: z.string(),
    createdBy: aiProgrammeAuthorSchema,
    createdAt: z.string().datetime(),
  })
  .openapi("AiProgrammeOverrideVersion");

export const aiProgrammeOverrideListSchema = z
  .object({ overrides: z.array(aiProgrammeOverrideVersionSchema) })
  .openapi("AiProgrammeOverrideList");

export const aiProgrammeOverrideBodySchema = z
  .object({
    ...overrideFieldsShape,
    reason,
    basedOnOverrideId: uuid.nullable().optional(),
  })
  .openapi("AiProgrammeOverrideBody");

export const aiProgrammeClearBodySchema = z
  .object({ reason, basedOnOverrideId: uuid.nullable().optional() })
  .openapi("AiProgrammeClearOverrideBody");

export const aiProgrammePreviewBodySchema = z
  .object(overrideFieldsShape)
  .openapi("AiProgrammePreviewBody");

export const aiProgrammeValuesSchema = z
  .object({
    currencyCode: z.string(),
    iapPriceMinor: int.nullable(),
    licensePriceMinor: int.nullable(),
    parentPriceMinor: int.nullable(),
    minSeats: int,
    maxShareBps: int,
    conversionTiers: z.array(aiProgrammeTierSchema),
    largeSchoolMinSeats: int,
    largeSchoolShareBps: int,
    contentBonusTiers: z.array(aiProgrammeTierSchema),
    bonusRequiresConversionShare: z.boolean(),
    measurementOffsetDays: int,
    nonpaymentGraceDays: int,
    monthToMonthShareBps: int,
    payoutMode: aiProgrammePayoutModeSchema,
    overridden: z.array(aiProgrammeOverrideFieldSchema),
  })
  .openapi("AiProgrammeValues");

export const aiProgrammeIssueSchema = z
  .object({
    field: z.string(),
    code: aiProgrammeIssueCodeSchema,
    index: int.optional(),
  })
  .openapi("AiProgrammeIssue");

export const aiProgrammePreviewSchema = z
  .object({ effective: aiProgrammeValuesSchema, issues: z.array(aiProgrammeIssueSchema) })
  .openapi("AiProgrammePreview");

export const schoolAiProgrammeSchema = z
  .object({
    schoolId: uuid,
    currencyCode: z.string(),
    global: aiProgrammeVersionSchema,
    override: aiProgrammeOverrideVersionSchema.nullable(),
    effective: aiProgrammeValuesSchema,
  })
  .openapi("SchoolAiProgramme");

export const licenseAiProgrammeStampSchema = z
  .object({
    versionId: uuid,
    versionNumber: int,
    overrideId: uuid.nullable(),
    overrideVersionNumber: int.nullable(),
    appliedAt: z.string().datetime(),
    nonpaymentGraceDays: int,
    current: z.boolean(),
  })
  .openapi("LicenseAiProgrammeStamp");

export const licenseAiProgrammeSchema = z
  .object({
    licenseId: uuid,
    stamp: licenseAiProgrammeStampSchema,
    signed: aiProgrammeValuesSchema,
    current: aiProgrammeValuesSchema,
    currentVersionNumber: int,
    currentOverrideVersionNumber: int.nullable(),
    changes: z.array(aiProgrammeFieldSchema),
  })
  .openapi("LicenseAiProgramme");

export const aiProgrammeReapplyBodySchema = z.object({ reason }).openapi("AiProgrammeReapplyBody");
