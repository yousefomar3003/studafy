import { z } from "@hono/zod-openapi";

import { INVOICE_STATUSES } from "./invoices";
import { QUOTE_STATUSES } from "./quotes";
import { audienceSchema } from "./schemas";
import { AUDIENCES } from "./service";

/**
 * OpenAPI schemas for license pricing, quotes, invoices and payments (session 3). Every nested
 * object and every enum carries its own `.openapi("Name")`, and every enum used in a query also
 * appears in a response body: the Dart client generator collides on inline names and emits no model
 * for an enum seen only in a query. A *nullable* enum is the exception: a nullable reference to a
 * named enum becomes a wrapper class the generator cannot compile, so nullable enum properties stay
 * inline (the generator names them after their parent schema and property, which is unique), and the
 * list filters echoed in responses take an "all" value instead of null.
 */

const uuid = z.string().uuid();
const minor = z.number().int();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const reason = z.string().trim().min(1).max(500);

export const volumeBasisSchema = z.enum(["per_audience", "overall"]).openapi("LicenseVolumeBasis");
export const quoteKindSchema = z
  .enum(["new", "seat_increase", "extension"])
  .openapi("LicenseQuoteKind");
export const quoteStatusSchema = z.enum(QUOTE_STATUSES).openapi("LicenseQuoteStatus");
export const invoiceStatusSchema = z.enum(INVOICE_STATUSES).openapi("LicenseInvoiceStatus");
export const invoiceFilterSchema = z
  .enum(["all", ...INVOICE_STATUSES, "unpaid", "overdue"])
  .openapi("LicenseInvoiceFilter");
/** An audience, or none: inline, see above. */
const nullableAudience = () => z.enum(AUDIENCES).nullable();
const receiptStatusSchema = z.enum(["pending", "matched"]).openapi("LicenseReceiptStatus");

// ---------------------------------------------------------------------------------------------------
// Parameters and queries
// ---------------------------------------------------------------------------------------------------

const pathUuid = (name: string) => uuid.openapi({ param: { name, in: "path" } });

export const currencyParamsSchema = z.object({
  currencyCode: currencyCode.openapi({ param: { name: "currencyCode", in: "path" } }),
});
export const platformQuoteParamsSchema = z.object({
  schoolId: pathUuid("schoolId"),
  quoteId: pathUuid("quoteId"),
});
export const platformSchoolOnlyParamsSchema = z.object({ schoolId: pathUuid("schoolId") });
export const platformInvoiceParamsSchema = z.object({
  schoolId: pathUuid("schoolId"),
  invoiceId: pathUuid("invoiceId"),
});
export const platformPaymentParamsSchema = z.object({
  schoolId: pathUuid("schoolId"),
  paymentId: pathUuid("paymentId"),
});
export const platformReceiptParamsSchema = z.object({
  schoolId: pathUuid("schoolId"),
  receiptId: pathUuid("receiptId"),
});
export const schoolQuoteParamsSchema = z.object({ quoteId: pathUuid("quoteId") });
export const schoolInvoiceParamsSchema = z.object({ invoiceId: pathUuid("invoiceId") });
export const schoolReceiptParamsSchema = z.object({ receiptId: pathUuid("receiptId") });

export const quoteListQuerySchema = z.object({ status: quoteStatusSchema.optional() });

export const invoiceListQuerySchema = z.object({
  status: invoiceFilterSchema.default("all"),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const platformInvoiceListQuerySchema = invoiceListQuerySchema.extend({
  schoolId: uuid.optional(),
});

// ---------------------------------------------------------------------------------------------------
// Price settings and bank details
// ---------------------------------------------------------------------------------------------------

const volumeBracketSchema = z
  .object({
    audience: nullableAudience(),
    minSeats: z.number().int().min(1).max(1_000_000),
    discountBps: z.number().int().min(0).max(10_000),
  })
  .openapi("LicenseVolumeBracket");

const durationDiscountSchema = z
  .object({
    minMonths: z.number().int().min(1).max(120),
    discountBps: z.number().int().min(0).max(10_000),
  })
  .openapi("LicenseDurationDiscount");

export const priceSettingsSchema = z
  .object({
    currencyCode,
    volumeBasis: volumeBasisSchema,
    volumeBrackets: z.array(volumeBracketSchema),
    durationDiscounts: z.array(durationDiscountSchema),
    updatedAt: z.string().datetime().nullable(),
  })
  .openapi("LicensePriceSettings");

export const priceSettingsListSchema = z
  .object({ settings: z.array(priceSettingsSchema) })
  .openapi("LicensePriceSettingsList");

export const priceSettingsBodySchema = z
  .object({
    volumeBasis: volumeBasisSchema,
    volumeBrackets: z.array(volumeBracketSchema).max(50),
    durationDiscounts: z.array(durationDiscountSchema).max(20),
  })
  .openapi("LicensePriceSettingsBody");

export const bankDetailsSchema = z
  .object({
    bankName: z.string().trim().min(1).max(200),
    accountName: z.string().trim().min(1).max(200),
    iban: z.string().regex(/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/),
    swift: z.string().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/),
    currencyCode,
  })
  .openapi("LicenseBankDetails");

export const bankDetailsResponseSchema = z
  .object({ bankDetails: bankDetailsSchema.nullable() })
  .openapi("LicenseBankDetailsResponse");

// ---------------------------------------------------------------------------------------------------
// The calculator's breakdown
// ---------------------------------------------------------------------------------------------------

const nextVolumeBracketSchema = z
  .object({
    minSeats: z.number().int(),
    discountBps: z.number().int(),
    seatsToAdd: z.number().int(),
    pricePerSeatMonthMinor: minor,
  })
  .openapi("LicenseNextVolumeBracket");

const seatLineSchema = z
  .object({
    kind: z.literal("seats"),
    audience: audienceSchema,
    tierCode: z.string(),
    tierName: z.string(),
    seats: z.number().int(),
    volumeSeats: z.number().int(),
    months: z.number().int(),
    prorateDays: z.number().int().nullable(),
    listPricePerSeatMonthMinor: minor,
    listAmountMinor: minor,
    volumeDiscountBps: z.number().int(),
    volumeDiscountMinor: minor,
    durationDiscountBps: z.number().int(),
    durationDiscountMinor: minor,
    amountMinor: minor,
    pricePerSeatMonthMinor: minor,
    savingsMinor: minor,
    nextVolumeBracket: nextVolumeBracketSchema.nullable(),
  })
  .openapi("LicensePriceSeatLine");

const creditLineSchema = z
  .object({
    kind: z.literal("overlap_credit"),
    reference: z.string(),
    description: z.string(),
    creditMinor: minor,
    amountMinor: minor,
  })
  .openapi("LicensePriceCreditLine");

const adjustmentLineSchema = z
  .object({ kind: z.literal("adjustment"), reason: z.string(), amountMinor: minor })
  .openapi("LicensePriceAdjustmentLine");

const priceLineSchema = z
  .discriminatedUnion("kind", [seatLineSchema, creditLineSchema, adjustmentLineSchema])
  .openapi("LicensePriceLine");

export const breakdownSchema = z
  .object({
    currencyCode: z.string(),
    months: z.number().int(),
    prorateDays: z.number().int().nullable(),
    lines: z.array(priceLineSchema),
    listTotalMinor: minor,
    discountTotalMinor: minor,
    seatsSubtotalMinor: minor,
    creditTotalMinor: minor,
    adjustmentMinor: minor,
    totalMinor: minor,
    savingsMinor: minor,
    savingsBps: z.number().int(),
  })
  .openapi("LicensePriceBreakdown");

// ---------------------------------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------------------------------

const quoteAudienceInputSchema = z
  .object({ planId: uuid.nullable(), seats: z.number().int().min(0).max(100_000) })
  .openapi("LicenseQuoteAudienceInput");

const adjustmentSchema = z
  .object({
    amountMinor: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
    reason: z.string().trim().max(500),
  })
  .openapi("LicenseQuoteAdjustment");

const termsShape = {
  currencyCode: currencyCode.optional(),
  startsAt: z.string().datetime().optional(),
  months: z.number().int().min(1).max(120).optional(),
  includeFamilyPlus: z.boolean().optional(),
  student: quoteAudienceInputSchema.optional(),
  teacher: quoteAudienceInputSchema.optional(),
  parent: quoteAudienceInputSchema.optional(),
  includeOverlapCredits: z.boolean().optional(),
  adjustment: adjustmentSchema.nullable().optional(),
};

export const quoteBodySchema = z
  .object({
    kind: quoteKindSchema,
    licenseId: uuid.nullable().optional(),
    ...termsShape,
    notes: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .openapi("LicenseQuoteBody");

export const quoteReplaceBodySchema = z
  .object({ ...termsShape, notes: z.string().trim().min(1).max(2000).nullable().optional() })
  .openapi("LicenseQuoteReplaceBody");

export const calculateBodySchema = z
  .object({
    /** The school whose license and overlap credits to price with; omit for a list-price preview. */
    schoolId: uuid.optional(),
    kind: quoteKindSchema,
    licenseId: uuid.nullable().optional(),
    ...termsShape,
  })
  .openapi("LicenseQuoteCalculateBody");

const quoteAudienceSchema = z
  .object({ audience: audienceSchema, planId: uuid.nullable(), seats: z.number().int() })
  .openapi("LicenseQuoteAudience");

export const calculationSchema = z
  .object({
    kind: quoteKindSchema,
    licenseId: uuid.nullable(),
    currencyCode: z.string(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    months: z.number().int(),
    prorateDays: z.number().int().nullable(),
    includeFamilyPlus: z.boolean(),
    audiences: z.array(quoteAudienceSchema),
    breakdown: breakdownSchema,
  })
  .openapi("LicenseQuoteCalculation");

export const quoteSchema = z
  .object({
    id: uuid,
    schoolId: uuid,
    kind: quoteKindSchema,
    licenseId: uuid.nullable(),
    status: quoteStatusSchema,
    currencyCode: z.string(),
    minorUnit: z.number().int(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    months: z.number().int(),
    prorateDays: z.number().int().nullable(),
    includeFamilyPlus: z.boolean(),
    audiences: z.array(quoteAudienceSchema),
    adjustmentMinor: minor,
    adjustmentReason: z.string().nullable(),
    listTotalMinor: minor,
    discountTotalMinor: minor,
    creditTotalMinor: minor,
    totalMinor: minor,
    breakdown: breakdownSchema,
    pricedAt: z.string().datetime(),
    validUntil: z.string().datetime(),
    notes: z.string().nullable(),
    createdBy: uuid,
    sentAt: z.string().datetime().nullable(),
    acceptedAt: z.string().datetime().nullable(),
    acceptedBy: uuid.nullable(),
    acceptedByPlatform: z.boolean().nullable(),
    closedAt: z.string().datetime().nullable(),
    invoiceId: uuid.nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("LicenseQuote");

export const quoteListSchema = z
  .object({ quotes: z.array(quoteSchema) })
  .openapi("LicenseQuoteList");

// ---------------------------------------------------------------------------------------------------
// Invoices, payments, receipts
// ---------------------------------------------------------------------------------------------------

const invoiceShape = {
  id: uuid,
  schoolId: uuid,
  licenseId: uuid,
  quoteId: uuid.nullable(),
  number: z.string(),
  paymentReference: z.string(),
  currencyCode: z.string(),
  minorUnit: z.number().int(),
  issueDate: isoDate,
  dueDate: isoDate,
  subtotalMinor: minor,
  creditTotalMinor: minor,
  adjustmentMinor: minor,
  totalMinor: minor,
  paidMinor: minor,
  balanceMinor: minor,
  status: invoiceStatusSchema,
  overdueAt: z.string().datetime().nullable(),
  voidedAt: z.string().datetime().nullable(),
  voidReason: z.string().nullable(),
  createdAt: z.string().datetime(),
};

export const invoiceSchema = z.object(invoiceShape).openapi("LicenseInvoice");

export const invoiceListItemSchema = z
  .object({ ...invoiceShape, overdue: z.boolean() })
  .openapi("LicenseInvoiceListItem");

export const invoiceListSchema = z
  .object({ invoices: z.array(invoiceListItemSchema), status: invoiceFilterSchema })
  .openapi("LicenseInvoiceList");

export const platformInvoiceListSchema = z
  .object({
    invoices: z.array(
      z
        .object({ ...invoiceShape, overdue: z.boolean(), schoolName: z.string() })
        .openapi("PlatformLicenseInvoiceListItem"),
    ),
    status: invoiceFilterSchema,
  })
  .openapi("PlatformLicenseInvoiceList");

const invoiceLineSchema = z
  .object({
    position: z.number().int(),
    kind: z.enum(["seats", "overlap_credit", "adjustment"]).openapi("LicenseInvoiceLineKind"),
    description: z.string(),
    audience: nullableAudience(),
    planId: uuid.nullable(),
    seats: z.number().int().nullable(),
    months: z.number().int().nullable(),
    prorateDays: z.number().int().nullable(),
    listPricePerSeatMonthMinor: minor.nullable(),
    listAmountMinor: minor.nullable(),
    volumeDiscountBps: z.number().int().nullable(),
    volumeDiscountMinor: minor.nullable(),
    durationDiscountBps: z.number().int().nullable(),
    durationDiscountMinor: minor.nullable(),
    amountMinor: minor,
    overlapId: uuid.nullable(),
  })
  .openapi("LicenseInvoiceLine");

export const paymentSchema = z
  .object({
    id: uuid,
    invoiceId: uuid,
    amountMinor: minor,
    currencyCode: z.string(),
    receivedAt: z.string().datetime(),
    bankReference: z.string(),
    method: z.literal("bank_transfer"),
    hasReceiptFile: z.boolean(),
    note: z.string().nullable(),
    recordedBy: uuid,
    voidedAt: z.string().datetime().nullable(),
    voidReason: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("LicensePayment");

const receiptShape = {
  id: uuid,
  invoiceId: uuid,
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  note: z.string().nullable(),
  uploadedBy: uuid,
  status: receiptStatusSchema,
  paymentId: uuid.nullable(),
  matchedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
};

export const receiptSchema = z.object(receiptShape).openapi("LicensePaymentReceipt");

export const invoiceDetailSchema = z
  .object({
    ...invoiceShape,
    overdue: z.boolean(),
    lines: z.array(invoiceLineSchema),
    payments: z.array(paymentSchema),
    receipts: z.array(receiptSchema),
    bankDetails: bankDetailsSchema.nullable(),
  })
  .openapi("LicenseInvoiceDetail");

const renewalStopSchema = z
  .object({ overlapId: uuid, status: z.enum(["done", "failed"]), error: z.string().optional() })
  .openapi("LicenseBillingRenewalStop");

export const acceptQuoteResponseSchema = z
  .object({ quote: quoteSchema, invoice: invoiceSchema, renewalStops: z.array(renewalStopSchema) })
  .openapi("LicenseQuoteAcceptance");

export const voidBodySchema = z.object({ reason }).openapi("LicenseVoidBody");

export const activateEarlyBodySchema = z
  .object({ dueDate: isoDate })
  .openapi("LicenseActivateEarlyBody");

export const activateEarlyResponseSchema = z
  .object({
    invoice: invoiceSchema,
    licenseActivated: z.boolean(),
    renewalStops: z.array(renewalStopSchema),
  })
  .openapi("LicenseActivateEarlyResult");

export const recordPaymentBodySchema = z
  .object({
    amountMinor: z.number().int().positive().max(1_000_000_000_000),
    receivedAt: z.string().datetime(),
    bankReference: z.string().trim().min(1).max(100),
    note: z.string().trim().min(1).max(1000).nullable().optional(),
    receiptId: uuid.nullable().optional(),
    /** A temp key from POST .../license-payments/upload-url, promoted when the payment is saved. */
    receiptStorageKey: z.string().min(1).max(1024).nullable().optional(),
  })
  .openapi("LicenseRecordPaymentBody");

export const paymentResultSchema = z
  .object({
    payment: paymentSchema,
    invoice: invoiceSchema,
    licenseActivated: z.boolean(),
    renewalStops: z.array(renewalStopSchema),
  })
  .openapi("LicensePaymentResult");

export const voidPaymentResultSchema = z
  .object({ payment: paymentSchema, invoice: invoiceSchema })
  .openapi("LicensePaymentVoidResult");

export const paymentListSchema = z
  .object({ payments: z.array(paymentSchema) })
  .openapi("LicensePaymentList");

export const receiptUploadBodySchema = z
  .object({
    /** A temp key from POST /api/storage/upload-url with content_class "license.receipt". */
    storageKey: z.string().min(1).max(1024),
    note: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .openapi("LicenseReceiptUploadBody");

export const matchReceiptBodySchema = z
  .object({ paymentId: uuid })
  .openapi("LicenseReceiptMatchBody");

export const pendingReceiptListSchema = z
  .object({
    receipts: z.array(
      z
        .object({
          ...receiptShape,
          schoolId: uuid,
          schoolName: z.string(),
          invoiceNumber: z.string(),
          invoiceBalanceMinor: minor,
          currencyCode: z.string(),
        })
        .openapi("LicensePendingReceipt"),
    ),
  })
  .openapi("LicensePendingReceiptList");

export const uploadUrlBodySchema = z
  .object({
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(1).max(100),
    sizeBytes: z.number().int().positive(),
  })
  .openapi("LicenseUploadUrlBody");

export const uploadUrlSchema = z
  .object({ storageKey: z.string(), uploadUrl: z.string(), expiresAt: z.string().datetime() })
  .openapi("LicenseUploadUrl");

export const fileUrlSchema = z
  .object({ url: z.string(), expiresAt: z.string().datetime() })
  .openapi("LicenseFileUrl");

export const financeOverviewSchema = z
  .object({
    totals: z.array(
      z
        .object({
          currencyCode: z.string(),
          minorUnit: z.number().int(),
          receivedThisMonthMinor: minor,
          outstandingMinor: minor,
          overdueMinor: minor,
          unpaidInvoices: z.number().int(),
          overdueInvoices: z.number().int(),
        })
        .openapi("LicenseFinanceTotals"),
    ),
    pendingReceipts: z.number().int(),
  })
  .openapi("LicenseFinanceOverview");
