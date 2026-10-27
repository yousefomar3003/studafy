import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { withSystemTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { getLocalizedMessage } from "../../middleware/locale";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";
import { confirmUpload, getContentClass, requestUpload } from "../storage";

import {
  acceptQuoteResponseSchema,
  activateEarlyBodySchema,
  activateEarlyResponseSchema,
  bankDetailsResponseSchema,
  bankDetailsSchema,
  calculateBodySchema,
  calculationSchema,
  currencyParamsSchema,
  fileUrlSchema,
  financeOverviewSchema,
  invoiceDetailSchema,
  invoiceSchema,
  matchReceiptBodySchema,
  paymentResultSchema,
  pendingReceiptListSchema,
  platformInvoiceListQuerySchema,
  platformInvoiceListSchema,
  platformInvoiceParamsSchema,
  platformPaymentParamsSchema,
  platformQuoteParamsSchema,
  platformReceiptParamsSchema,
  platformSchoolOnlyParamsSchema,
  priceSettingsBodySchema,
  priceSettingsListSchema,
  priceSettingsSchema,
  quoteBodySchema,
  quoteListQuerySchema,
  quoteListSchema,
  quoteReplaceBodySchema,
  quoteSchema,
  receiptSchema,
  recordPaymentBodySchema,
  uploadUrlBodySchema,
  uploadUrlSchema,
  voidBodySchema,
  voidPaymentResultSchema,
} from "./billing-schemas";
import { licenseError } from "./context";
import {
  activateEarly,
  financeTotals,
  listInvoicesAcrossSchools,
  listPendingReceipts,
  matchReceipt,
  paymentReceiptKey,
  readBankDetails,
  readReceipt,
  recordPayment,
  requireInvoiceDetail,
  voidInvoice,
  voidPayment,
  writeBankDetails,
} from "./invoices";
import { listPriceSettings, priceQuote, replacePriceSettings } from "./pricing";
import {
  acceptQuote,
  createQuote,
  listQuotes,
  replaceQuote,
  requireQuote,
  sendQuote,
  withdrawQuote,
} from "./quotes";
import { readInSchool, runLicenseChange } from "./service";

import type { LicenseActor } from "./context";
import type { PricedQuote, QuoteTerms } from "./pricing";
import type { LicensingDeps } from "./service";
import type { StorageService } from "../../lib/storage";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * The super admin's license billing (docs/billing/feature-licensing.md, session 3): price settings
 * and bank details, the calculator, quotes, invoices, payments, receipts and the finance totals.
 * SUPER_ADMIN only (platform:read to read, platform:manage to change), web channel only, like the
 * rest of the console. Writes are audited from inside the service transaction: a change in a school
 * writes the console's two rows (./context.ts); a change to a global table (price settings, bank
 * details) one row in the operator's home school.
 */

const TAG = "Platform";

// ---------------------------------------------------------------------------------------------------
// Global: price settings, bank details, the calculator, cross-school lists
// ---------------------------------------------------------------------------------------------------

const listPriceSettingsRoute = createRoute({
  method: "get",
  path: "/api/platform/licenses/price-settings",
  operationId: "platformListLicensePriceSettings",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "License price settings per currency",
  description: "Volume brackets (by seats, per audience or overall) and duration discounts.",
  responses: standardResponses(
    { 200: { description: "Settings", schema: priceSettingsListSchema } },
    [401, 403],
  ),
});

const putPriceSettingsRoute = createRoute({
  method: "put",
  path: "/api/platform/licenses/price-settings/{currencyCode}",
  operationId: "platformPutLicensePriceSettings",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Replace a currency's license price settings",
  description:
    "Replaces the volume basis and every bracket. Brackets must not repeat a threshold, and " +
    "discounts are basis points (0-10000). 422 LICENSE_PRICING_INVALID otherwise.",
  request: {
    params: currencyParamsSchema,
    body: { required: true, content: { "application/json": { schema: priceSettingsBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The saved settings", schema: priceSettingsSchema } },
    [400, 401, 403, 422],
  ),
});

const getBankDetailsRoute = createRoute({
  method: "get",
  path: "/api/platform/licenses/bank-details",
  operationId: "platformGetLicenseBankDetails",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "The bank details printed on license invoices",
  responses: standardResponses(
    {
      200: { description: "Bank details, or null until saved", schema: bankDetailsResponseSchema },
    },
    [401, 403],
  ),
});

const putBankDetailsRoute = createRoute({
  method: "put",
  path: "/api/platform/licenses/bank-details",
  operationId: "platformPutLicenseBankDetails",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Save the bank details printed on license invoices",
  request: {
    body: { required: true, content: { "application/json": { schema: bankDetailsSchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Saved", schema: bankDetailsResponseSchema } },
    [400, 401, 403],
  ),
});

const calculateRoute = createRoute({
  method: "post",
  path: "/api/platform/licenses/quote",
  operationId: "platformCalculateLicenseQuote",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Price a license without saving",
  description:
    "The calculator: list price, volume and duration discounts, the price per seat before and " +
    "after, the savings, the next volume bracket, overlap credits (when `schoolId` is given) and " +
    "the manual adjustment. Nothing is stored.",
  request: {
    body: { required: true, content: { "application/json": { schema: calculateBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The price", schema: calculationSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const listInvoicesRoute = createRoute({
  method: "get",
  path: "/api/platform/licenses/invoices",
  operationId: "platformListLicenseInvoices",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "License invoices across schools",
  description:
    "Filter by status (`unpaid` = issued or partially paid; `overdue` = unpaid past due), by " +
    "school, and by issue date (`from`, `to`, inclusive). Newest first.",
  request: { query: platformInvoiceListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Invoices", schema: platformInvoiceListSchema } },
    [400, 401, 403],
  ),
});

const listReceiptsRoute = createRoute({
  method: "get",
  path: "/api/platform/licenses/receipts",
  operationId: "platformListPendingLicenseReceipts",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Transfer receipts waiting to be matched",
  responses: standardResponses(
    { 200: { description: "Pending receipts, oldest first", schema: pendingReceiptListSchema } },
    [401, 403],
  ),
});

const financeRoute = createRoute({
  method: "get",
  path: "/api/platform/licenses/finance",
  operationId: "platformGetLicenseFinance",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "License finance totals",
  description:
    "Per currency: received this calendar month (UTC), outstanding (every unpaid balance) and " +
    "overdue (unpaid past due); plus the number of receipts waiting to be matched.",
  responses: standardResponses(
    { 200: { description: "Totals", schema: financeOverviewSchema } },
    [401, 403],
  ),
});

// ---------------------------------------------------------------------------------------------------
// A school's quotes
// ---------------------------------------------------------------------------------------------------

const listQuotesRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/license-quotes",
  operationId: "platformListLicenseQuotes",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "A school's license quotes",
  request: { params: platformSchoolOnlyParamsSchema, query: quoteListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Quotes", schema: quoteListSchema } },
    [400, 401, 403],
  ),
});

const createQuoteRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-quotes",
  operationId: "platformCreateLicenseQuote",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Price and save a quote (draft)",
  description:
    "`new`: a term from `startsAt` for `months` (for `licenseId` if it is a draft or awaiting " +
    "payment, else a new license on acceptance). `seat_increase`: the license's new seat totals, " +
    "charged for the rest of its term at the new total's volume bracket. `extension`: `months` " +
    "more. Open overlap credits are included unless `includeOverlapCredits` is false.",
  request: {
    params: platformSchoolOnlyParamsSchema,
    body: { required: true, content: { "application/json": { schema: quoteBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The draft quote", schema: quoteSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const getQuoteRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/license-quotes/{quoteId}",
  operationId: "platformGetLicenseQuote",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "A quote",
  request: { params: platformQuoteParamsSchema },
  responses: standardResponses(
    { 200: { description: "The quote", schema: quoteSchema } },
    [401, 403, 404],
  ),
});

const replaceQuoteRoute = createRoute({
  method: "put",
  path: "/api/platform/schools/{schoolId}/license-quotes/{quoteId}",
  operationId: "platformReplaceLicenseQuote",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Re-price a draft quote with new terms",
  request: {
    params: platformQuoteParamsSchema,
    body: { required: true, content: { "application/json": { schema: quoteReplaceBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The quote", schema: quoteSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const sendQuoteRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/send",
  operationId: "platformSendLicenseQuote",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Send a draft quote to the school",
  description: "The school can see and accept it until `validUntil` (license.quote_validity_days).",
  request: { params: platformQuoteParamsSchema },
  responses: standardResponses(
    { 200: { description: "The sent quote", schema: quoteSchema } },
    [401, 403, 404, 409],
  ),
});

const acceptQuoteRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/accept",
  operationId: "platformAcceptLicenseQuote",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Mark a quote accepted on the school's behalf",
  description:
    "Applies the terms to the license (creating it awaiting payment, adding seats, or extending " +
    "it) and issues the invoice. 409 LICENSE_QUOTE_STALE when the license changed after pricing.",
  request: { params: platformQuoteParamsSchema },
  responses: standardResponses(
    { 200: { description: "The quote and its invoice", schema: acceptQuoteResponseSchema } },
    [401, 403, 404, 409, 422],
  ),
});

const withdrawQuoteRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/withdraw",
  operationId: "platformWithdrawLicenseQuote",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Withdraw a draft or sent quote",
  request: { params: platformQuoteParamsSchema },
  responses: standardResponses(
    { 200: { description: "The quote", schema: quoteSchema } },
    [401, 403, 404, 409],
  ),
});

// ---------------------------------------------------------------------------------------------------
// A school's invoices, payments and receipts
// ---------------------------------------------------------------------------------------------------

const getInvoiceRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}",
  operationId: "platformGetLicenseInvoice",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "An invoice with its lines, payments and receipts",
  request: { params: platformInvoiceParamsSchema },
  responses: standardResponses(
    { 200: { description: "The invoice", schema: invoiceDetailSchema } },
    [401, 403, 404],
  ),
});

const voidInvoiceRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/void",
  operationId: "platformVoidLicenseInvoice",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Void an unpaid invoice",
  description:
    "With a reason. 409 LICENSE_INVOICE_HAS_PAYMENTS while it has payments (void those first). " +
    "Its overlap credits become available to the next quote.",
  request: {
    params: platformInvoiceParamsSchema,
    body: { required: true, content: { "application/json": { schema: voidBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The invoice", schema: invoiceSchema } },
    [400, 401, 403, 404, 409],
  ),
});

const activateEarlyRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/activate-early",
  operationId: "platformActivateLicenseEarly",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Activate the license before it is paid, with a due date",
  request: {
    params: platformInvoiceParamsSchema,
    body: { required: true, content: { "application/json": { schema: activateEarlyBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The invoice and license", schema: activateEarlyResponseSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const recordPaymentRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments",
  operationId: "platformRecordLicensePayment",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Record a bank transfer",
  description:
    "Partial payments are allowed; 422 LICENSE_PAYMENT_EXCEEDS_BALANCE above the balance. " +
    "`receiptId` matches a school receipt to it; `receiptStorageKey` attaches a file uploaded " +
    "through `.../license-payments/upload-url`. The license activates when the invoice is paid " +
    "in full (if it is not active yet and the school has no other active license).",
  request: {
    params: platformInvoiceParamsSchema,
    body: { required: true, content: { "application/json": { schema: recordPaymentBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The payment and the invoice", schema: paymentResultSchema } },
    [400, 401, 403, 404, 409, 422, 503],
  ),
});

const voidPaymentRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-payments/{paymentId}/void",
  operationId: "platformVoidLicensePayment",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Void a payment",
  description:
    "With a reason; never deleted. The invoice's balance and status follow, and a receipt matched " +
    "to it goes back to pending. The license is not suspended.",
  request: {
    params: platformPaymentParamsSchema,
    body: { required: true, content: { "application/json": { schema: voidBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The payment and the invoice", schema: voidPaymentResultSchema } },
    [400, 401, 403, 404, 409],
  ),
});

const uploadUrlRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-payments/upload-url",
  operationId: "platformLicensePaymentUploadUrl",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Upload URL for a payment's receipt file",
  description: "PDF, JPEG or PNG up to 10 MiB, stored under the school.",
  request: {
    params: platformSchoolOnlyParamsSchema,
    body: { required: true, content: { "application/json": { schema: uploadUrlBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "A pre-signed PUT", schema: uploadUrlSchema } },
    [400, 401, 403, 503],
  ),
});

const paymentFileRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/license-payments/{paymentId}/receipt-file",
  operationId: "platformGetLicensePaymentFile",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Download a payment's attached file",
  request: { params: platformPaymentParamsSchema },
  responses: standardResponses(
    { 200: { description: "A short-lived URL", schema: fileUrlSchema } },
    [401, 403, 404, 503],
  ),
});

const matchReceiptRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-receipts/{receiptId}/match",
  operationId: "platformMatchLicenseReceipt",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Match a school's receipt to a payment",
  request: {
    params: platformReceiptParamsSchema,
    body: { required: true, content: { "application/json": { schema: matchReceiptBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The receipt", schema: receiptSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const receiptFileRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/license-receipts/{receiptId}/file",
  operationId: "platformGetLicenseReceiptFile",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Download a school's receipt",
  request: { params: platformReceiptParamsSchema },
  responses: standardResponses(
    { 200: { description: "A short-lived URL", schema: fileUrlSchema } },
    [401, 403, 404, 503],
  ),
});

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

function platformActor(c: Context<AppEnv>): LicenseActor {
  const auth = requireAuth(c);
  return {
    kind: "platform",
    userId: auth.userId,
    homeSchoolId: auth.schoolId,
    requestId: c.get("requestId"),
    locale: (c.get("locale") ?? "en") as SupportedLocale,
  };
}

export function requireStorage(
  storage: StorageService | null | undefined,
  locale: SupportedLocale = "en",
): StorageService {
  if (!storage) {
    throw new CodedHttpException(
      503,
      ERROR_CODES.STORAGE_NOT_CONFIGURED,
      getLocalizedMessage(ERROR_CODES.STORAGE_NOT_CONFIGURED, locale),
    );
  }
  return storage;
}

/** Body terms to the service's, with dates parsed. */
export function termsFrom(body: {
  kind?: QuoteTerms["kind"];
  licenseId?: string | null;
  startsAt?: string;
  [key: string]: unknown;
}): Omit<QuoteTerms, "kind"> & { kind?: QuoteTerms["kind"] } {
  return {
    ...(body as Omit<QuoteTerms, "startsAt">),
    startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
  };
}

function calculationView(priced: PricedQuote) {
  return {
    kind: priced.kind,
    licenseId: priced.licenseId,
    currencyCode: priced.currencyCode,
    startsAt: priced.startsAt.toISOString(),
    endsAt: priced.endsAt.toISOString(),
    months: priced.months,
    prorateDays: priced.prorateDays,
    includeFamilyPlus: priced.includeFamilyPlus,
    audiences: (["student", "teacher", "parent"] as const).map((audience) => ({
      audience,
      ...priced.audiences[audience],
    })),
    breakdown: priced.pricing,
  };
}

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------

export function platformLicenseBillingRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  const writesOnly = (c: Context<AppEnv>, next: () => Promise<void>) =>
    c.req.method === "GET" ? next() : manage(c, next);

  // Repeated per path rather than relied on from the console's other routes: this file stands alone.
  routes.use("/api/platform/licenses/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/schools/:schoolId/license-quotes", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/schools/:schoolId/license-quotes/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/schools/:schoolId/license-invoices", requireChannel(AUTH_CHANNELS.WEB));
  routes.use(
    "/api/platform/schools/:schoolId/license-invoices/*",
    requireChannel(AUTH_CHANNELS.WEB),
  );
  routes.use("/api/platform/schools/:schoolId/license-payments", requireChannel(AUTH_CHANNELS.WEB));
  routes.use(
    "/api/platform/schools/:schoolId/license-payments/*",
    requireChannel(AUTH_CHANNELS.WEB),
  );
  routes.use("/api/platform/schools/:schoolId/license-receipts", requireChannel(AUTH_CHANNELS.WEB));
  routes.use(
    "/api/platform/schools/:schoolId/license-receipts/*",
    requireChannel(AUTH_CHANNELS.WEB),
  );
  routes.use("/api/platform/licenses/*", requirePermission(PERMISSIONS.PLATFORM_READ));
  routes.use(
    "/api/platform/schools/:schoolId/license-quotes",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-quotes/*",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-invoices",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-invoices/*",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-payments",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-payments/*",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-receipts",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-receipts/*",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use("/api/platform/licenses/*", writesOnly);
  routes.use("/api/platform/schools/:schoolId/license-quotes", writesOnly);
  routes.use("/api/platform/schools/:schoolId/license-quotes/*", writesOnly);
  routes.use("/api/platform/schools/:schoolId/license-invoices", writesOnly);
  routes.use("/api/platform/schools/:schoolId/license-invoices/*", writesOnly);
  routes.use("/api/platform/schools/:schoolId/license-payments", writesOnly);
  routes.use("/api/platform/schools/:schoolId/license-payments/*", writesOnly);
  routes.use("/api/platform/schools/:schoolId/license-receipts", writesOnly);
  routes.use("/api/platform/schools/:schoolId/license-receipts/*", writesOnly);

  // The calculator and the upload URL write nothing themselves; like the other upload-url routes they
  // declare the table their work ends up in, for the audit coverage gate.
  routes.use("/api/platform/licenses/quote", auditAction("insert", "license_quotes"));
  routes.use(
    "/api/platform/schools/:schoolId/license-payments/upload-url",
    auditAction("insert", "license_payments"),
  );
  routes.use(
    "/api/platform/licenses/price-settings/:currencyCode",
    auditAction("update", "license_price_settings"),
  );
  routes.use("/api/platform/licenses/bank-details", auditAction("update", "platform_settings"));
  routes.use(
    "/api/platform/schools/:schoolId/license-quotes",
    auditAction("insert", "license_quotes"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-quotes/:quoteId",
    auditAction("update", "license_quotes"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-quotes/:quoteId/send",
    auditAction("update", "license_quotes"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-quotes/:quoteId/accept",
    auditAction("update", "license_quotes"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-quotes/:quoteId/withdraw",
    auditAction("update", "license_quotes"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-invoices/:invoiceId/void",
    auditAction("update", "license_invoices"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-invoices/:invoiceId/activate-early",
    auditAction("update", "license_invoices"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-invoices/:invoiceId/payments",
    auditAction("insert", "license_payments"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-payments/:paymentId/void",
    auditAction("update", "license_payments"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-receipts/:receiptId/match",
    auditAction("update", "license_payment_receipts"),
  );

  /** A write in one school, database refusals mapped, after-commit work done. */
  const change = runLicenseChange;

  // --- Global -------------------------------------------------------------------------------------

  routes.openapi(listPriceSettingsRoute, async (c) => {
    const settings = await withSystemTx(deps.database, listPriceSettings);
    return c.json({ settings }, 200);
  });

  routes.openapi(putPriceSettingsRoute, async (c) => {
    const { currencyCode } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const settings = await withSystemTx(deps.database, (tx) =>
      replacePriceSettings(tx, currencyCode, body, actor),
    );
    return c.json(settings, 200);
  });

  routes.openapi(getBankDetailsRoute, async (c) => {
    const bankDetails = await withSystemTx(deps.database, readBankDetails);
    return c.json({ bankDetails }, 200);
  });

  routes.openapi(putBankDetailsRoute, async (c) => {
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const bankDetails = await withSystemTx(deps.database, (tx) =>
      writeBankDetails(tx, body, actor),
    );
    return c.json({ bankDetails }, 200);
  });

  routes.openapi(calculateRoute, async (c) => {
    const { schoolId, ...body } = c.req.valid("json");
    const actor = platformActor(c);
    const terms = termsFrom(body) as QuoteTerms;
    let priced: PricedQuote;
    if (schoolId) {
      priced = await readInSchool(deps, schoolId, actor, (tx) => priceQuote(tx, terms, actor));
    } else {
      // A list-price preview: no school, so no license and no credits.
      if (terms.licenseId) throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
      priced = await withSystemTx(deps.database, (tx) =>
        priceQuote(tx, terms, actor, { withCredits: false }),
      );
    }
    return c.json(calculationView(priced), 200);
  });

  routes.openapi(listInvoicesRoute, async (c) => {
    const query = c.req.valid("query");
    const invoices = await listInvoicesAcrossSchools(deps.database, query);
    return c.json({ invoices, status: query.status }, 200);
  });

  routes.openapi(listReceiptsRoute, async (c) => {
    const receipts = await listPendingReceipts(deps.database);
    return c.json({ receipts }, 200);
  });

  routes.openapi(financeRoute, async (c) => {
    const [totals, pending] = [
      await financeTotals(deps.database),
      await listPendingReceipts(deps.database),
    ];
    return c.json({ totals, pendingReceipts: pending.length }, 200);
  });

  // --- Quotes -------------------------------------------------------------------------------------

  routes.openapi(listQuotesRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    const quotes = await readInSchool(deps, schoolId, platformActor(c), (tx) =>
      listQuotes(tx, status ? [status] : undefined),
    );
    return c.json({ quotes }, 200);
  });

  routes.openapi(createQuoteRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const { result } = await change(deps, schoolId, actor, async (tx) => ({
      result: await createQuote(tx, schoolId, termsFrom(body) as QuoteTerms, actor),
      versions: new Map(),
      pending: [],
    }));
    return c.json(result, 201);
  });

  routes.openapi(getQuoteRoute, async (c) => {
    const { schoolId, quoteId } = c.req.valid("param");
    const actor = platformActor(c);
    const quote = await readInSchool(deps, schoolId, actor, (tx) =>
      requireQuote(tx, quoteId, actor),
    );
    return c.json(quote, 200);
  });

  routes.openapi(replaceQuoteRoute, async (c) => {
    const { schoolId, quoteId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const { result } = await change(deps, schoolId, actor, async (tx) => ({
      result: await replaceQuote(tx, schoolId, quoteId, termsFrom(body), actor),
      versions: new Map(),
      pending: [],
    }));
    return c.json(result, 200);
  });

  routes.openapi(sendQuoteRoute, async (c) => {
    const { schoolId, quoteId } = c.req.valid("param");
    const actor = platformActor(c);
    const { result } = await change(deps, schoolId, actor, async (tx) => ({
      result: await sendQuote(tx, schoolId, quoteId, actor),
      versions: new Map(),
      pending: [],
    }));
    return c.json(result, 200);
  });

  routes.openapi(acceptQuoteRoute, async (c) => {
    const { schoolId, quoteId } = c.req.valid("param");
    const actor = platformActor(c);
    const { result, renewals } = await change(deps, schoolId, actor, (tx) =>
      acceptQuote(tx, schoolId, quoteId, actor),
    );
    return c.json({ ...result, renewalStops: renewals }, 200);
  });

  routes.openapi(withdrawQuoteRoute, async (c) => {
    const { schoolId, quoteId } = c.req.valid("param");
    const actor = platformActor(c);
    const { result } = await change(deps, schoolId, actor, async (tx) => ({
      result: await withdrawQuote(tx, schoolId, quoteId, actor),
      versions: new Map(),
      pending: [],
    }));
    return c.json(result, 200);
  });

  // --- Invoices, payments, receipts ---------------------------------------------------------------

  routes.openapi(getInvoiceRoute, async (c) => {
    const { schoolId, invoiceId } = c.req.valid("param");
    const actor = platformActor(c);
    const invoice = await readInSchool(deps, schoolId, actor, (tx) =>
      requireInvoiceDetail(tx, invoiceId, actor),
    );
    return c.json(invoice, 200);
  });

  routes.openapi(voidInvoiceRoute, async (c) => {
    const { schoolId, invoiceId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const actor = platformActor(c);
    const { result } = await change(deps, schoolId, actor, async (tx) => ({
      result: await voidInvoice(tx, schoolId, invoiceId, reason, actor),
      versions: new Map(),
      pending: [],
    }));
    return c.json(result, 200);
  });

  routes.openapi(activateEarlyRoute, async (c) => {
    const { schoolId, invoiceId } = c.req.valid("param");
    const { dueDate } = c.req.valid("json");
    const actor = platformActor(c);
    const { result, renewals } = await change(deps, schoolId, actor, (tx) =>
      activateEarly(tx, schoolId, invoiceId, dueDate, actor),
    );
    return c.json({ ...result, renewalStops: renewals }, 200);
  });

  routes.openapi(recordPaymentRoute, async (c) => {
    const { schoolId, invoiceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    // The file is promoted before the payment's transaction: storage calls never sit inside one. A
    // payment that then fails leaves an orphan object, which storage reconciliation sweeps.
    let receiptStorageKey: string | null = null;
    if (body.receiptStorageKey) {
      const storage = requireStorage(deps.storage, actor.locale);
      const confirmed = await confirmUpload(storage, schoolId, getContentClass("license.receipt"), {
        storageKey: body.receiptStorageKey,
      });
      receiptStorageKey = confirmed.storageKey;
    }
    const { result, renewals } = await change(deps, schoolId, actor, (tx) =>
      recordPayment(
        tx,
        schoolId,
        invoiceId,
        { ...body, receivedAt: new Date(body.receivedAt), receiptStorageKey },
        actor,
      ),
    );
    return c.json({ ...result, renewalStops: renewals }, 201);
  });

  routes.openapi(voidPaymentRoute, async (c) => {
    const { schoolId, paymentId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const actor = platformActor(c);
    const { result } = await change(deps, schoolId, actor, async (tx) => ({
      result: await voidPayment(tx, schoolId, paymentId, reason, actor),
      versions: new Map(),
      pending: [],
    }));
    return c.json(result, 200);
  });

  routes.openapi(uploadUrlRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const body = c.req.valid("json");
    const storage = requireStorage(deps.storage, platformActor(c).locale);
    const { storageKey, presigned } = await requestUpload(
      storage,
      schoolId,
      getContentClass("license.receipt"),
      body,
    );
    return c.json(
      { storageKey, uploadUrl: presigned.url, expiresAt: presigned.expiresAt.toISOString() },
      200,
    );
  });

  routes.openapi(paymentFileRoute, async (c) => {
    const { schoolId, paymentId } = c.req.valid("param");
    const actor = platformActor(c);
    const storage = requireStorage(deps.storage, actor.locale);
    const key = await readInSchool(deps, schoolId, actor, (tx) => paymentReceiptKey(tx, paymentId));
    if (!key) throw licenseError(404, ERROR_CODES.LICENSE_PAYMENT_NOT_FOUND, actor.locale);
    const signed = await storage.presign(key, "GET");
    return c.json({ url: signed.url, expiresAt: signed.expiresAt.toISOString() }, 200);
  });

  routes.openapi(matchReceiptRoute, async (c) => {
    const { schoolId, receiptId } = c.req.valid("param");
    const { paymentId } = c.req.valid("json");
    const actor = platformActor(c);
    const { result } = await change(deps, schoolId, actor, async (tx) => ({
      result: await matchReceipt(tx, schoolId, receiptId, paymentId, actor),
      versions: new Map(),
      pending: [],
    }));
    return c.json(result, 200);
  });

  routes.openapi(receiptFileRoute, async (c) => {
    const { schoolId, receiptId } = c.req.valid("param");
    const actor = platformActor(c);
    const storage = requireStorage(deps.storage, actor.locale);
    const receipt = await readInSchool(deps, schoolId, actor, (tx) => readReceipt(tx, receiptId));
    if (!receipt) throw licenseError(404, ERROR_CODES.LICENSE_RECEIPT_NOT_FOUND, actor.locale);
    const signed = await storage.presign(receipt.storageKey, "GET");
    return c.json({ url: signed.url, expiresAt: signed.expiresAt.toISOString() }, 200);
  });

  return routes;
}
