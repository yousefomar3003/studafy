import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { JOB_NAMES, PERMISSIONS, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction, emitAuditLog } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission, requirePermissionIn } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import {
  createInvoiceBatchBodySchema,
  invoiceBatchIdParamSchema,
  invoiceBatchItemListSchema,
  invoiceBatchItemQuerySchema,
  invoiceBatchListQuerySchema,
  invoiceBatchListSchema,
  invoiceBatchSchema,
  invoiceDetailSchema,
  invoiceIdParamSchema,
  invoiceListSchema,
  invoiceQuerySchema,
} from "./schemas";
import {
  createInvoiceBatch,
  getInvoiceBatch,
  getInvoiceBatchItems,
  getInvoiceDetail,
  listInvoiceBatches,
  listInvoices,
  type InvoiceBatchRow,
  type InvoiceDetail,
  type InvoiceRow,
} from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function toInvoiceResponse(row: InvoiceRow) {
  return { ...row, last_synced_at: row.last_synced_at.toISOString() };
}

function toInvoiceDetailResponse(row: InvoiceDetail) {
  return { ...row, last_synced_at: row.last_synced_at.toISOString() };
}

function toBatchResponse(row: InvoiceBatchRow) {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listInvoicesRoute = createRoute({
  method: "get",
  path: "/api/finance/invoices",
  tags: ["Finance"],
  operationId: "listInvoices",
  summary: "List invoices",
  description:
    "Cursor-paginated invoices for the caller's school, served from the local read model " +
    "app.invoice_cache. A `search` value is matched against the invoice number first (an exact, " +
    "indexed lookup — the fast path), and only falls back to a partial match over the student's " +
    "name/admission number when no invoice has that exact number.",
  security: [{ bearerAuth: [] }],
  request: { query: invoiceQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated invoices.", schema: invoiceListSchema } },
    [400, 401, 403, 500],
  ),
});

const getInvoiceRoute = createRoute({
  method: "get",
  path: "/api/finance/invoices/{invoiceId}",
  tags: ["Finance"],
  operationId: "getInvoice",
  summary: "Get an invoice, with its lines",
  description:
    "One invoice from the local read model, including line items parsed from the " +
    "cached ERPNext Sales Invoice document.",
  security: [{ bearerAuth: [] }],
  request: { params: invoiceIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The invoice.", schema: invoiceDetailSchema } },
    [401, 403, 404, 500],
  ),
});

const createInvoiceBatchRoute = createRoute({
  method: "post",
  path: "/api/finance/invoices/batches",
  tags: ["Finance"],
  operationId: "createInvoiceBatch",
  summary: "Start a batch invoice generation run",
  description:
    "Resolves the target students (every actively enrolled student, or those actively enrolled " +
    "in the given classes), seeds one tracked item per student, and dispatches the run to the " +
    "billing worker, which calls ERPNext once per student. Poll GET .../batches/{batchId} and " +
    ".../batches/{batchId}/items for progress.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createInvoiceBatchBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created batch.", schema: invoiceBatchSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const listInvoiceBatchesRoute = createRoute({
  method: "get",
  path: "/api/finance/invoices/batches",
  tags: ["Finance"],
  operationId: "listInvoiceBatches",
  summary: "List batch invoice generation runs",
  description: "Cursor-paginated batch generation runs for the caller's school, newest first.",
  security: [{ bearerAuth: [] }],
  request: { query: invoiceBatchListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated batches.", schema: invoiceBatchListSchema } },
    [401, 403, 500],
  ),
});

const getInvoiceBatchRoute = createRoute({
  method: "get",
  path: "/api/finance/invoices/batches/{batchId}",
  tags: ["Finance"],
  operationId: "getInvoiceBatch",
  summary: "Get a batch invoice generation run",
  description:
    "The batch header with running per-status counts — the poll target for a progress meter.",
  security: [{ bearerAuth: [] }],
  request: { params: invoiceBatchIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The batch.", schema: invoiceBatchSchema } },
    [401, 403, 404, 500],
  ),
});

const getInvoiceBatchItemsRoute = createRoute({
  method: "get",
  path: "/api/finance/invoices/batches/{batchId}/items",
  tags: ["Finance"],
  operationId: "getInvoiceBatchItems",
  summary: "List per-student results for a batch",
  description:
    "Cursor-paginated, optionally filtered by status — the poll target for the batch's per-row table.",
  security: [{ bearerAuth: [] }],
  request: { params: invoiceBatchIdParamSchema, query: invoiceBatchItemQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated batch items.", schema: invoiceBatchItemListSchema } },
    [401, 403, 404, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/** BullMQ job options mirroring `bulk-invite-routes.ts`'s dispatch of `process-bulk-invite`: three
 * attempts with exponential backoff, and completed/failed jobs retained for later inspection. */
const BATCH_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
};

export function financeInvoiceRoutes(
  database: Database,
  redis: RedisClient | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const billingQueue = redis
    ? new Queue(QUEUE_NAMES.BILLING, { connection: redis as never })
    : null;

  // Permission gates. BILLING_READ covers every read surface; BILLING_UPDATE (the same gate the
  // fee-structure gateway write routes use) covers starting a batch, since it calls ERPNext on the
  // caller's behalf. GET and POST /api/finance/invoices/batches share one path with different
  // required permissions per verb — `routes.use(path, ...)` middleware applies to every method on
  // that path, so it cannot express "READ for GET, UPDATE for POST" — each handler below asserts
  // its own permission via `requirePermissionIn` instead.
  routes.use("/api/finance/invoices", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use("/api/finance/invoices/batches/*", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use("/api/finance/invoices/:invoiceId", requirePermission(PERMISSIONS.BILLING_READ));

  routes.use("/api/finance/invoices/batches", auditAction("insert", "invoice_batches"));

  // --- Invoices ---

  routes.openapi(listInvoicesRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listInvoices(tx, auth.schoolId, query),
    );

    return c.json({ invoices: rows.map(toInvoiceResponse), next_cursor }, 200);
  });

  // ST-249: registered ahead of getInvoiceRoute below, not after — Hono resolves an ambiguous path
  // by registration order, not specificity, and "/api/finance/invoices/batches" also matches
  // getInvoiceRoute's "{invoiceId}" pattern with invoiceId="batches". Registered after, this route
  // was dead: every request to it hit getInvoiceDetail("batches", ...) instead.
  routes.openapi(listInvoiceBatchesRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.BILLING_READ);
    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listInvoiceBatches(tx, auth.schoolId, query),
    );

    return c.json({ invoice_batches: rows.map(toBatchResponse), next_cursor }, 200);
  });

  routes.openapi(getInvoiceRoute, async (c) => {
    const auth = requireAuth(c);
    const { invoiceId } = c.req.valid("param");

    const detail = await withTenantTx(database, tenantFrom(c), (tx) =>
      getInvoiceDetail(tx, auth.schoolId, invoiceId),
    );

    return c.json(toInvoiceDetailResponse(detail), 200);
  });

  // --- Batches ---

  routes.openapi(createInvoiceBatchRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.BILLING_UPDATE);
    const log = c.get("log");
    const body = c.req.valid("json");

    const batch = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const created = await createInvoiceBatch(tx, auth.schoolId, auth.userId, {
        fee_structure_erpnext_name: body.fee_structure_erpnext_name,
        period_title: body.period_title,
        due_date: body.due_date,
        target_class_ids: body.target_class_ids,
      });

      await emitAuditLog(tx, {
        action: "insert",
        targetTable: "invoice_batches",
        targetId: created.id,
        newValues: {
          fee_structure_erpnext_name: created.fee_structure_erpnext_name,
          period_title: created.period_title,
          total_count: created.total_count,
        },
      });

      return created;
    });

    if (billingQueue) {
      await billingQueue.add(
        JOB_NAMES.GENERATE_BATCH_INVOICES,
        {
          version: 1,
          schoolId: batch.school_id,
          batchId: batch.id,
          feeStructureErpnextName: batch.fee_structure_erpnext_name,
          periodTitle: batch.period_title,
          dueDate: batch.due_date ?? undefined,
        },
        BATCH_JOB_OPTIONS,
      );
    }

    log?.info({ invoice_batch_id: batch.id, total: batch.total_count }, "invoice batch created");

    return c.json(toBatchResponse(batch), 201);
  });

  routes.openapi(getInvoiceBatchRoute, async (c) => {
    const auth = requireAuth(c);
    const { batchId } = c.req.valid("param");

    const batch = await withTenantTx(database, tenantFrom(c), (tx) =>
      getInvoiceBatch(tx, auth.schoolId, batchId),
    );

    return c.json(toBatchResponse(batch), 200);
  });

  routes.openapi(getInvoiceBatchItemsRoute, async (c) => {
    const auth = requireAuth(c);
    const { batchId } = c.req.valid("param");
    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      getInvoiceBatchItems(tx, auth.schoolId, batchId, query),
    );

    return c.json(
      {
        items: rows.map((row) => ({
          ...row,
          created_at: row.created_at.toISOString(),
          updated_at: row.updated_at.toISOString(),
        })),
        next_cursor,
      },
      200,
    );
  });

  return routes;
}
