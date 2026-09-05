import { randomUUID } from "crypto";

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { requireStorage } from "../../../lib/storage/client";
import { buildTempKey } from "../../../lib/storage/keys";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import {
  confirmAttachmentBodySchema,
  createExpenseBodySchema,
  expenseIdParamSchema,
  expenseListSchema,
  expenseQuerySchema,
  expenseSchema,
  expenseSummaryQuerySchema,
  expenseSummarySchema,
  updateExpenseBodySchema,
  uploadUrlBodySchema,
  uploadUrlResponseSchema,
} from "./schemas";
import {
  confirmAttachment,
  createExpense,
  getExpense,
  getMonthlySummary,
  listExpenses,
  updateExpense,
  type ExpenseRow,
} from "./service";

import type { Database } from "../../../db/client";
import type { StorageService } from "../../../lib/storage";
import type { AppEnv } from "../../../middleware/requestId";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { z } from "@hono/zod-openapi";
import type { Context } from "hono";

type ExpenseResponse = z.infer<typeof expenseSchema>;

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function toResponse(row: ExpenseRow): ExpenseResponse {
  return {
    ...row,
    last_synced_at: row.last_synced_at.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/api/finance/expenses",
  tags: ["Finance"],
  operationId: "listExpenses",
  summary: "List expenses",
  description:
    "Paginated expenses for the caller's school, served from the local read model. " +
    "Supports filtering by document_type, category, and date range.",
  security: [{ bearerAuth: [] }],
  request: { query: expenseQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated expenses.", schema: expenseListSchema } },
    [400, 401, 403, 500],
  ),
});

const getRoute = createRoute({
  method: "get",
  path: "/api/finance/expenses/{expenseId}",
  tags: ["Finance"],
  operationId: "getExpense",
  summary: "Get an expense",
  description:
    "Returns a single expense by id or ERPNext docname. Includes a pre-signed attachment URL if one exists.",
  security: [{ bearerAuth: [] }],
  request: { params: expenseIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The requested expense.", schema: expenseSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const createRouteDef = createRoute({
  method: "post",
  path: "/api/finance/expenses",
  tags: ["Finance"],
  operationId: "createExpense",
  summary: "Create an expense",
  description:
    "Forwards the expense to ERPNext as a Purchase Invoice, Expense Claim, or Journal Entry " +
    "depending on document_type. ERPNext owns validation, category existence, and currency rules. " +
    "Send an Idempotency-Key to make retries safe.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createExpenseBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created expense.", schema: expenseSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const updateRouteDef = createRoute({
  method: "patch",
  path: "/api/finance/expenses/{expenseId}",
  tags: ["Finance"],
  operationId: "updateExpense",
  summary: "Update an expense",
  description:
    "Forwards the change to ERPNext. A submitted document may be immutable there; " +
    "ERPNext's refusal is surfaced as a 400 rather than worked around.",
  security: [{ bearerAuth: [] }],
  request: {
    params: expenseIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateExpenseBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated expense.", schema: expenseSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const uploadUrlRoute = createRoute({
  method: "post",
  path: "/api/finance/expenses/upload-url",
  tags: ["Finance"],
  operationId: "createExpenseUploadUrl",
  summary: "Get a pre-signed upload URL for an expense attachment",
  description:
    "Returns a pre-signed S3 PUT URL for direct file upload, along with the storage key " +
    "to reference the uploaded file when creating or updating an expense.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: uploadUrlBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "Pre-signed upload URL.", schema: uploadUrlResponseSchema } },
    [400, 401, 403, 503, 500],
  ),
});

const confirmAttachmentRoute = createRoute({
  method: "post",
  path: "/api/finance/expenses/{expenseId}/attachments",
  tags: ["Finance"],
  operationId: "confirmExpenseAttachment",
  summary: "Confirm an expense attachment",
  description:
    "Promotes a staged temp upload to permanent storage and links it to the expense. " +
    "Call this after uploading bytes to the pre-signed URL from the upload-url endpoint.",
  security: [{ bearerAuth: [] }],
  request: {
    params: expenseIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: confirmAttachmentBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The expense with updated attachment.", schema: expenseSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const summaryRoute = createRoute({
  method: "get",
  path: "/api/finance/expenses/summary",
  tags: ["Finance"],
  operationId: "getExpenseSummary",
  summary: "Monthly expense summary",
  description:
    "Aggregates expenses by category for a given year and month. Returns per-category totals " +
    "and a grand total, all in minor units.",
  security: [{ bearerAuth: [] }],
  request: { query: expenseSummaryQuerySchema },
  responses: standardResponses(
    { 200: { description: "Monthly expense summary.", schema: expenseSummarySchema } },
    [400, 401, 403, 500],
  ),
});

export function expenseRoutes(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
  storage: StorageService | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/finance/expenses", auditAction("insert", "expense_cache"));
  routes.use("/api/finance/expenses/:expenseId", auditAction("update", "expense_cache"));
  routes.use("/api/finance/expenses/upload-url", auditAction("insert", "expense_cache"));
  routes.use(
    "/api/finance/expenses/:expenseId/attachments",
    auditAction("update", "expense_cache"),
  );

  routes.use("/api/finance/expenses", requirePermission(PERMISSIONS.BILLING_UPDATE));
  routes.use("/api/finance/expenses/:expenseId", requirePermission(PERMISSIONS.BILLING_UPDATE));
  routes.use("/api/finance/expenses/summary", requirePermission(PERMISSIONS.BILLING_READ));

  routes.openapi(listRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listExpenses(tx, auth.schoolId, query),
    );

    return c.json({ expenses: rows.map(toResponse), total }, 200);
  });

  // ST-249: registered ahead of getRoute below, not after — Hono resolves an ambiguous path by
  // registration order, not specificity, and "/api/finance/expenses/summary" also matches
  // getRoute's "{expenseId}" pattern with expenseId="summary". Registered after, this route was
  // dead: every request to it hit getExpense("summary", ...) instead, which failed a uuid cast in
  // Postgres and surfaced as an unhandled 500 rather than the summary payload.
  routes.openapi(summaryRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const summary = await withTenantTx(database, tenantFrom(c), (tx) =>
      getMonthlySummary(tx, auth.schoolId, query.year, query.month, query.document_type),
    );

    return c.json({ year: query.year, month: query.month, ...summary }, 200);
  });

  routes.openapi(getRoute, async (c) => {
    const auth = requireAuth(c);
    const { expenseId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getExpense(tx, auth.schoolId, expenseId, storage),
    );

    return c.json(toResponse(row), 200);
  });

  routes.openapi(createRouteDef, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const acceptLanguage = c.req.header("Accept-Language");

    const row = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const erpnext = await erpnextFactory.forSchool(tx, auth.schoolId);
      return createExpense(tx, erpnext, auth.schoolId, body, acceptLanguage);
    });

    return c.json(toResponse(row), 201);
  });

  routes.openapi(updateRouteDef, async (c) => {
    const auth = requireAuth(c);
    const { expenseId } = c.req.valid("param");
    const body = c.req.valid("json");
    const acceptLanguage = c.req.header("Accept-Language");

    const row = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const erpnext = await erpnextFactory.forSchool(tx, auth.schoolId);
      return updateExpense(tx, erpnext, auth.schoolId, expenseId, body, acceptLanguage);
    });

    return c.json(toResponse(row), 200);
  });

  routes.openapi(uploadUrlRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const s3 = requireStorage(storage);

    const objectId = randomUUID();
    const storageKey = buildTempKey(auth.schoolId, objectId, body.file_name);
    const presigned = await s3.presign(storageKey, "PUT", body.content_type);

    return c.json(
      {
        upload_url: presigned.url,
        storage_key: storageKey,
        expires_at: presigned.expiresAt.toISOString(),
      },
      200,
    );
  });

  routes.openapi(confirmAttachmentRoute, async (c) => {
    const auth = requireAuth(c);
    const { expenseId } = c.req.valid("param");
    const body = c.req.valid("json");
    const s3 = requireStorage(storage);

    const row = await withTenantTx(database, tenantFrom(c), async (tx) =>
      confirmAttachment(tx, s3, auth.schoolId, expenseId, body.storage_key),
    );

    return c.json(toResponse(row), 200);
  });

  return routes;
}
