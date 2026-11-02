import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";
import { confirmUpload, getContentClass, recordStorageUpload } from "../storage";

import { requireStorage } from "./billing-platform-routes";
import {
  acceptQuoteResponseSchema,
  fileUrlSchema,
  invoiceDetailSchema,
  invoiceListQuerySchema,
  invoiceListSchema,
  paymentListSchema,
  quoteListQuerySchema,
  quoteListSchema,
  quoteSchema,
  receiptSchema,
  receiptUploadBodySchema,
  schoolInvoiceParamsSchema,
  schoolQuoteParamsSchema,
  schoolReceiptParamsSchema,
} from "./billing-schemas";
import { licenseError } from "./context";
import {
  createReceipt,
  listPayments,
  listSchoolInvoices,
  readReceipt,
  requireInvoiceDetail,
} from "./invoices";
import { acceptQuote, listQuotes, requireQuote, SCHOOL_VISIBLE } from "./quotes";
import { readInSchool, runLicenseChange } from "./service";

import type { LicenseActor } from "./context";
import type { LicensingDeps } from "./service";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * The school's side of license billing (docs/billing/feature-licensing.md, session 3): its quotes
 * (sent, accepted, expired -- never drafts), accepting one, its invoices with the bank details and
 * payment reference, uploading a transfer receipt, and its payment history. `license:read` to read,
 * `license:manage` to accept or upload; ORG_ADMIN and PRINCIPAL hold both.
 */

const TAG = "Licensing";

const listQuotesRoute = createRoute({
  method: "get",
  path: "/api/school/license/quotes",
  operationId: "listSchoolLicenseQuotes",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "The school's license quotes",
  description: "Sent, accepted and expired quotes, newest first.",
  request: { query: quoteListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Quotes", schema: quoteListSchema } },
    [400, 401, 403],
  ),
});

const getQuoteRoute = createRoute({
  method: "get",
  path: "/api/school/license/quotes/{quoteId}",
  operationId: "getSchoolLicenseQuote",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "A quote, with its price breakdown",
  request: { params: schoolQuoteParamsSchema },
  responses: standardResponses(
    { 200: { description: "The quote", schema: quoteSchema } },
    [401, 403, 404],
  ),
});

const acceptQuoteRoute = createRoute({
  method: "post",
  path: "/api/school/license/quotes/{quoteId}/accept",
  operationId: "acceptSchoolLicenseQuote",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Accept a quote",
  description:
    "Applies the quote to the license and issues the invoice to pay by bank transfer. 409 " +
    "LICENSE_QUOTE_EXPIRED past `validUntil`; 409 LICENSE_QUOTE_STALE when the license changed " +
    "after it was priced (ask for a new quote).",
  request: { params: schoolQuoteParamsSchema },
  responses: standardResponses(
    { 200: { description: "The quote and its invoice", schema: acceptQuoteResponseSchema } },
    [401, 403, 404, 409, 422],
  ),
});

const listInvoicesRoute = createRoute({
  method: "get",
  path: "/api/school/license/invoices",
  operationId: "listSchoolLicenseInvoices",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "The school's license invoices",
  request: { query: invoiceListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Invoices", schema: invoiceListSchema } },
    [400, 401, 403],
  ),
});

const getInvoiceRoute = createRoute({
  method: "get",
  path: "/api/school/license/invoices/{invoiceId}",
  operationId: "getSchoolLicenseInvoice",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "An invoice, with the bank details and payment reference",
  request: { params: schoolInvoiceParamsSchema },
  responses: standardResponses(
    { 200: { description: "The invoice", schema: invoiceDetailSchema } },
    [401, 403, 404],
  ),
});

const uploadReceiptRoute = createRoute({
  method: "post",
  path: "/api/school/license/invoices/{invoiceId}/receipts",
  operationId: "uploadSchoolLicenseReceipt",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Upload a transfer receipt",
  description:
    "Upload the file first with POST /api/storage/upload-url (content_class `license.receipt`: " +
    "PDF, JPEG or PNG up to 10 MiB), then send its `storageKey` here. The super admin matches it " +
    "to the payment they record.",
  request: {
    params: schoolInvoiceParamsSchema,
    body: { required: true, content: { "application/json": { schema: receiptUploadBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The receipt, pending", schema: receiptSchema } },
    [400, 401, 403, 404, 409, 503],
  ),
});

const listPaymentsRoute = createRoute({
  method: "get",
  path: "/api/school/license/payments",
  operationId: "listSchoolLicensePayments",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "The school's payment history",
  description: "Every recorded payment, voided ones included, newest first.",
  responses: standardResponses(
    { 200: { description: "Payments", schema: paymentListSchema } },
    [401, 403],
  ),
});

const receiptFileRoute = createRoute({
  method: "get",
  path: "/api/school/license/receipts/{receiptId}/file",
  operationId: "getSchoolLicenseReceiptFile",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Download an uploaded receipt",
  request: { params: schoolReceiptParamsSchema },
  responses: standardResponses(
    { 200: { description: "A short-lived URL", schema: fileUrlSchema } },
    [401, 403, 404, 503],
  ),
});

function schoolActor(c: Context<AppEnv>): LicenseActor & { schoolId: string } {
  const auth = requireAuth(c);
  return {
    kind: "school",
    userId: auth.userId,
    homeSchoolId: auth.schoolId,
    schoolId: auth.schoolId,
    requestId: c.get("requestId"),
    locale: (c.get("locale") ?? "en") as SupportedLocale,
  };
}

export function schoolLicenseBillingRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.LICENSE_MANAGE);
  const writesOnly = (c: Context<AppEnv>, next: () => Promise<void>) =>
    c.req.method === "GET" ? next() : manage(c, next);

  // Repeated per path rather than relied on from the seat routes: this file stands alone.
  routes.use("/api/school/license/quotes", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/quotes/*", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/invoices", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/invoices/*", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/payments", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/payments/*", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/receipts", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/receipts/*", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/quotes", writesOnly);
  routes.use("/api/school/license/quotes/*", writesOnly);
  routes.use("/api/school/license/invoices", writesOnly);
  routes.use("/api/school/license/invoices/*", writesOnly);
  routes.use("/api/school/license/payments", writesOnly);
  routes.use("/api/school/license/payments/*", writesOnly);
  routes.use("/api/school/license/receipts", writesOnly);
  routes.use("/api/school/license/receipts/*", writesOnly);
  routes.use("/api/school/license/quotes/:quoteId/accept", auditAction("update", "license_quotes"));
  routes.use(
    "/api/school/license/invoices/:invoiceId/receipts",
    auditAction("insert", "license_payment_receipts"),
  );

  routes.openapi(listQuotesRoute, async (c) => {
    const actor = schoolActor(c);
    const { status } = c.req.valid("query");
    const statuses = status ? SCHOOL_VISIBLE.filter((s) => s === status) : SCHOOL_VISIBLE;
    const quotes = await readInSchool(deps, actor.schoolId, actor, (tx) =>
      listQuotes(tx, statuses),
    );
    return c.json({ quotes }, 200);
  });

  routes.openapi(getQuoteRoute, async (c) => {
    const actor = schoolActor(c);
    const { quoteId } = c.req.valid("param");
    const quote = await readInSchool(deps, actor.schoolId, actor, (tx) =>
      requireQuote(tx, quoteId, actor, { schoolVisible: true }),
    );
    return c.json(quote, 200);
  });

  routes.openapi(acceptQuoteRoute, async (c) => {
    const actor = schoolActor(c);
    const { quoteId } = c.req.valid("param");
    const { result, renewals } = await runLicenseChange(deps, actor.schoolId, actor, (tx) =>
      acceptQuote(tx, actor.schoolId, quoteId, actor),
    );
    return c.json({ ...result, renewalStops: renewals }, 200);
  });

  routes.openapi(listInvoicesRoute, async (c) => {
    const actor = schoolActor(c);
    const query = c.req.valid("query");
    const invoices = await readInSchool(deps, actor.schoolId, actor, (tx) =>
      listSchoolInvoices(tx, query),
    );
    return c.json({ invoices, status: query.status }, 200);
  });

  routes.openapi(getInvoiceRoute, async (c) => {
    const actor = schoolActor(c);
    const { invoiceId } = c.req.valid("param");
    const invoice = await readInSchool(deps, actor.schoolId, actor, (tx) =>
      requireInvoiceDetail(tx, invoiceId, actor),
    );
    return c.json(invoice, 200);
  });

  routes.openapi(uploadReceiptRoute, async (c) => {
    const actor = schoolActor(c);
    const { invoiceId } = c.req.valid("param");
    const { storageKey, note } = c.req.valid("json");
    const storage = requireStorage(deps.storage, actor.locale);
    // The invoice is checked before the object is promoted, so a wrong id leaves the upload in temp/.
    await readInSchool(deps, actor.schoolId, actor, (tx) =>
      requireInvoiceDetail(tx, invoiceId, actor),
    );
    const confirmed = await confirmUpload(
      storage,
      actor.schoolId,
      getContentClass("license.receipt"),
      { storageKey },
    );
    const { result } = await runLicenseChange(deps, actor.schoolId, actor, async (tx) => {
      const receipt = await createReceipt(
        tx,
        actor.schoolId,
        invoiceId,
        {
          storageKey: confirmed.storageKey,
          fileName: confirmed.originalFileName,
          contentType: confirmed.contentType,
          sizeBytes: confirmed.sizeBytes,
        },
        note ?? null,
        actor,
      );
      // A receipt counts toward the school's storage like any upload; it is never refused for the
      // cap, since it is evidence of a payment.
      await recordStorageUpload(tx, confirmed.sizeBytes);
      return { result: receipt, versions: new Map(), pending: [] };
    });
    return c.json(result, 201);
  });

  routes.openapi(listPaymentsRoute, async (c) => {
    const actor = schoolActor(c);
    const payments = await readInSchool(deps, actor.schoolId, actor, (tx) => listPayments(tx));
    return c.json({ payments }, 200);
  });

  routes.openapi(receiptFileRoute, async (c) => {
    const actor = schoolActor(c);
    const { receiptId } = c.req.valid("param");
    const storage = requireStorage(deps.storage, actor.locale);
    const receipt = await readInSchool(deps, actor.schoolId, actor, (tx) =>
      readReceipt(tx, receiptId),
    );
    if (!receipt) throw licenseError(404, ERROR_CODES.LICENSE_RECEIPT_NOT_FOUND, actor.locale);
    const signed = await storage.presign(receipt.storageKey, "GET");
    return c.json({ url: signed.url, expiresAt: signed.expiresAt.toISOString() }, 200);
  });

  return routes;
}
