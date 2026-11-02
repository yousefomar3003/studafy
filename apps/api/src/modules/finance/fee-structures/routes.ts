import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import {
  createFeeStructureBodySchema,
  feeStructureIdParamSchema,
  feeStructureListSchema,
  feeStructureQuerySchema,
  feeStructureSchema,
  updateFeeStructureBodySchema,
} from "./schemas";
import {
  createFeeStructure,
  listFeeStructures,
  updateFeeStructure,
  type FeeStructureRow,
} from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { z } from "@hono/zod-openapi";
import type { Context } from "hono";

type FeeStructureResponse = z.infer<typeof feeStructureSchema>;

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

/** Dates cross the wire as ISO strings; the schema declares them that way. */
function toResponse(row: FeeStructureRow): FeeStructureResponse {
  return { ...row, last_synced_at: row.last_synced_at.toISOString() };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/api/finance/fee-structures",
  tags: ["Finance"],
  operationId: "listFeeStructures",
  summary: "List fee structures",
  description:
    "Paginated fee structures for the caller's school, served from the local read model that " +
    "ERPNext webhooks and gateway writes keep current. Reading does not call ERPNext, so the " +
    "list still renders while ERPNext is briefly unavailable.",
  security: [{ bearerAuth: [] }],
  request: { query: feeStructureQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated fee structures.", schema: feeStructureListSchema } },
    [400, 401, 403, 500],
  ),
});

const createRouteDef = createRoute({
  method: "post",
  path: "/api/finance/fee-structures",
  tags: ["Finance"],
  operationId: "createFeeStructure",
  summary: "Create a fee structure",
  description:
    "Forwards the structure to ERPNext, which owns validation, currency rules, and totals. " +
    "ERPNext's own rejection message is returned verbatim on 400, in the language of the " +
    "request's Accept-Language header. Send an Idempotency-Key to make retries safe.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createFeeStructureBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created fee structure.", schema: feeStructureSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const updateRouteDef = createRoute({
  method: "patch",
  path: "/api/finance/fee-structures/{feeStructureId}",
  tags: ["Finance"],
  operationId: "updateFeeStructure",
  summary: "Update a fee structure",
  description:
    "Forwards the change to ERPNext. A submitted structure is immutable there — amending one " +
    "produces a new document and leaves previously issued invoices pointing at the original. " +
    "ERPNext's refusal is surfaced as a 400 rather than worked around.",
  security: [{ bearerAuth: [] }],
  request: {
    params: feeStructureIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateFeeStructureBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated fee structure.", schema: feeStructureSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function feeStructureRoutes(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/finance/fee-structures", auditAction("insert", "fee_structure_cache"));
  routes.use(
    "/api/finance/fee-structures/:feeStructureId",
    auditAction("update", "fee_structure_cache"),
  );

  // Permission guards. BILLING_READ / BILLING_UPDATE already exist and FINANCE_PERMISSIONS
  // already holds both, so the FINANCE role gains this surface without a matrix change.
  routes.use("/api/finance/fee-structures", requirePermission(PERMISSIONS.BILLING_UPDATE));
  routes.use(
    "/api/finance/fee-structures/:feeStructureId",
    requirePermission(PERMISSIONS.BILLING_UPDATE),
  );

  // --- List ---

  routes.openapi(listRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listFeeStructures(tx, auth.schoolId, query),
    );

    return c.json({ fee_structures: rows.map(toResponse), total }, 200);
  });

  // --- Create ---

  routes.openapi(createRouteDef, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const acceptLanguage = c.req.header("Accept-Language");

    const row = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const erpnext = await erpnextFactory.forSchool(tx, auth.schoolId);
      return createFeeStructure(
        tx,
        erpnext,
        auth.schoolId,
        {
          title: body.title,
          academic_year_id: body.academic_year_id,
          program: body.program,
          currency: body.currency,
          components: body.components,
        },
        acceptLanguage,
      );
    });

    return c.json(toResponse(row), 201);
  });

  // --- Update ---

  routes.openapi(updateRouteDef, async (c) => {
    const auth = requireAuth(c);
    const { feeStructureId } = c.req.valid("param");
    const body = c.req.valid("json");
    const acceptLanguage = c.req.header("Accept-Language");

    const row = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const erpnext = await erpnextFactory.forSchool(tx, auth.schoolId);
      return updateFeeStructure(tx, erpnext, auth.schoolId, feeStructureId, body, acceptLanguage);
    });

    return c.json(toResponse(row), 200);
  });

  return routes;
}
