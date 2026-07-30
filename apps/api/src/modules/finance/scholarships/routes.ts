import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import {
  awardIdParamSchema,
  awardListSchema,
  awardQuerySchema,
  awardSchema,
  createAwardBodySchema,
  scholarshipDiscountListSchema,
  scholarshipDiscountQuerySchema,
  scholarshipDiscountSchema,
} from "./schemas";
import {
  confirmAward,
  createAward,
  listAwards,
  listScholarshipDiscounts,
  type AwardRow,
  type ScholarshipDiscountRow,
} from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { z } from "@hono/zod-openapi";
import type { Context } from "hono";

type ScholarshipDiscountResponse = z.infer<typeof scholarshipDiscountSchema>;
type AwardResponse = z.infer<typeof awardSchema>;

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

function toDiscountResponse(row: ScholarshipDiscountRow): ScholarshipDiscountResponse {
  return {
    id: row.id,
    school_id: row.school_id,
    erpnext_docname: row.erpnext_docname,
    erpnext_status: row.erpnext_status,
    title: row.title,
    discount_type: row.discount_type as "percentage" | "fixed",
    amount: row.amount,
    scope: row.scope as "global" | "fee_category",
    fee_category: row.fee_category,
    currency: row.currency,
    currency_minor_unit: row.currency_minor_unit,
    is_active: row.is_active,
    last_synced_at: row.last_synced_at.toISOString(),
  };
}

function toAwardResponse(row: AwardRow): AwardResponse {
  return {
    id: row.id,
    school_id: row.school_id,
    student_id: row.student_id,
    scholarship_discount_id: row.scholarship_discount_id,
    scholarship_discount_title: row.scholarship_discount_title,
    award_status: row.award_status as "pending" | "confirmed" | "cancelled",
    awarded_by: row.awarded_by,
    confirmed_by: row.confirmed_by,
    confirmed_at: row.confirmed_at?.toISOString() ?? null,
    erpnext_docname: row.erpnext_docname,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listDiscountsRoute = createRoute({
  method: "get",
  path: "/api/finance/scholarship-discounts",
  tags: ["Finance"],
  operationId: "listScholarshipDiscounts",
  summary: "List scholarship/discount configurations",
  description:
    "Available scholarship and discount configurations from ERPNext, served from the local " +
    "read model. These define the types of discounts (percentage or fixed, global or per " +
    "fee-category) that can be awarded to students.",
  security: [{ bearerAuth: [] }],
  request: { query: scholarshipDiscountQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated scholarship/discount configs.",
        schema: scholarshipDiscountListSchema,
      },
    },
    [400, 401, 403, 500],
  ),
});

const listAwardsRoute = createRoute({
  method: "get",
  path: "/api/finance/scholarship-discounts/awards",
  tags: ["Finance"],
  operationId: "listAwards",
  summary: "List scholarship/discount awards",
  description:
    "Paginated list of awards for the caller's school. Awards represent the application of a " +
    "scholarship or discount to a specific student, with a maker-checker lifecycle.",
  security: [{ bearerAuth: [] }],
  request: { query: awardQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated awards.", schema: awardListSchema } },
    [400, 401, 403, 500],
  ),
});

const createAwardRouteDef = createRoute({
  method: "post",
  path: "/api/finance/scholarship-discounts/awards",
  tags: ["Finance"],
  operationId: "createAward",
  summary: "Create a scholarship/discount award (maker step)",
  description:
    "Creates a pending award record linking a student to a scholarship or discount config. " +
    "A second user must confirm the award via the confirm endpoint before it takes effect. " +
    "The awarder and confirmer must be different users.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createAwardBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created award.", schema: awardSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const confirmAwardRouteDef = createRoute({
  method: "post",
  path: "/api/finance/scholarship-discounts/awards/{awardId}/confirm",
  tags: ["Finance"],
  operationId: "confirmAward",
  summary: "Confirm a scholarship/discount award (checker step)",
  description:
    "Confirms a pending award. The confirming user must differ from the award creator. " +
    "On confirmation the award is forwarded to ERPNext and reflected in subsequent " +
    "invoice generation.",
  security: [{ bearerAuth: [] }],
  request: { params: awardIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The confirmed award.", schema: awardSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function scholarshipDiscountRoutes(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/finance/scholarship-discounts/awards", auditAction("insert", "award_cache"));
  routes.use(
    "/api/finance/scholarship-discounts/awards/{awardId}/confirm",
    auditAction("update", "award_cache"),
  );

  routes.use("/api/finance/scholarship-discounts*", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use(
    "/api/finance/scholarship-discounts/awards",
    requirePermission(PERMISSIONS.BILLING_UPDATE),
  );
  routes.use(
    "/api/finance/scholarship-discounts/awards/{awardId}/confirm",
    requirePermission(PERMISSIONS.BILLING_UPDATE),
  );

  // --- List scholarship/discount configs ---

  routes.openapi(listDiscountsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listScholarshipDiscounts(tx, auth.schoolId, query),
    );

    return c.json({ scholarship_discounts: rows.map(toDiscountResponse), total }, 200);
  });

  // --- List awards ---

  routes.openapi(listAwardsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listAwards(tx, auth.schoolId, query),
    );

    return c.json({ awards: rows.map(toAwardResponse), total }, 200);
  });

  // --- Create award (maker) ---

  routes.openapi(createAwardRouteDef, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createAward(tx, auth.schoolId, auth.userId, {
        student_id: body.student_id,
        scholarship_discount_id: body.scholarship_discount_id,
      }),
    );

    return c.json(toAwardResponse(row), 201);
  });

  // --- Confirm award (checker) ---

  routes.openapi(confirmAwardRouteDef, async (c) => {
    const auth = requireAuth(c);
    const { awardId } = c.req.valid("param");
    const acceptLanguage = c.req.header("Accept-Language");

    const row = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const erpnext = await erpnextFactory.forSchool(tx, auth.schoolId);
      return confirmAward(tx, erpnext, auth.schoolId, auth.userId, awardId, acceptLanguage);
    });

    return c.json(toAwardResponse(row), 200);
  });

  return routes;
}
