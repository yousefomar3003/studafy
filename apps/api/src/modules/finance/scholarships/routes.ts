import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { withStudentIdentityTx } from "../students/service";

import {
  awardIdParamSchema,
  awardListSchema,
  awardQuerySchema,
  awardSchema,
  createAwardBodySchema,
  createScholarshipBodySchema,
  decideAwardBodySchema,
  rejectAwardBodySchema,
  scholarshipIdParamSchema,
  scholarshipListSchema,
  scholarshipQuerySchema,
  scholarshipSchema,
  updateScholarshipBodySchema,
} from "./schemas";
import {
  createAward,
  createScholarship,
  decideAward,
  getAward,
  listAwards,
  listScholarships,
  updateScholarship,
} from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

function tenantFrom(c: Context<AppEnv>): { schoolId: string; userId: string; requestId?: string } {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listScholarshipsDef = createRoute({
  method: "get",
  path: "/api/finance/scholarships",
  tags: ["Finance"],
  operationId: "listScholarships",
  summary: "List the school's scholarships",
  description: "Active scholarships first, then by name.",
  security: [{ bearerAuth: [] }],
  request: { query: scholarshipQuerySchema },
  responses: standardResponses(
    { 200: { description: "The school's scholarships.", schema: scholarshipListSchema } },
    [400, 401, 403, 500],
  ),
});

const createScholarshipDef = createRoute({
  method: "post",
  path: "/api/finance/scholarships",
  tags: ["Finance"],
  operationId: "createScholarship",
  summary: "Create a scholarship",
  description:
    "A percentage or fixed-amount reduction, on every fee or one fee category. Creating it " +
    "discounts nobody: a student benefits only once an award of it is approved.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createScholarshipBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created scholarship.", schema: scholarshipSchema } },
    [400, 401, 403, 409, 500],
  ),
});

const updateScholarshipDef = createRoute({
  method: "patch",
  path: "/api/finance/scholarships/{scholarshipId}",
  tags: ["Finance"],
  operationId: "updateScholarship",
  summary: "Rename, describe, or activate/deactivate a scholarship",
  security: [{ bearerAuth: [] }],
  request: {
    params: scholarshipIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateScholarshipBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated scholarship.", schema: scholarshipSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listAwardsDef = createRoute({
  method: "get",
  path: "/api/finance/scholarship-awards",
  tags: ["Finance"],
  operationId: "listScholarshipAwards",
  summary: "List scholarship awards",
  description:
    "Newest first. Filter by status (e.g. the admin's `pending_approval` queue), student or scholarship.",
  security: [{ bearerAuth: [] }],
  request: { query: awardQuerySchema },
  responses: standardResponses(
    { 200: { description: "Scholarship awards.", schema: awardListSchema } },
    [400, 401, 403, 500],
  ),
});

const createAwardDef = createRoute({
  method: "post",
  path: "/api/finance/scholarship-awards",
  tags: ["Finance"],
  operationId: "createScholarshipAward",
  summary: "Request a scholarship for a student",
  description:
    "Creates a `pending_approval` award. It discounts nothing until the school admin approves it.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: createAwardBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The requested award.", schema: awardSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const approveAwardDef = createRoute({
  method: "post",
  path: "/api/finance/scholarship-awards/{awardId}/approve",
  tags: ["Finance"],
  operationId: "approveScholarshipAward",
  summary: "Approve a scholarship award (school admin)",
  description:
    "From `pending_approval`. The student's invoices generated from now on are discounted; " +
    "invoices already issued are not changed.",
  security: [{ bearerAuth: [] }],
  request: {
    params: awardIdParamSchema,
    body: { required: true, content: { "application/json": { schema: decideAwardBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The approved award.", schema: awardSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const rejectAwardDef = createRoute({
  method: "post",
  path: "/api/finance/scholarship-awards/{awardId}/reject",
  tags: ["Finance"],
  operationId: "rejectScholarshipAward",
  summary: "Reject a scholarship award (school admin)",
  description: "From `pending_approval`, with a mandatory reason shown to finance.",
  security: [{ bearerAuth: [] }],
  request: {
    params: awardIdParamSchema,
    body: { required: true, content: { "application/json": { schema: rejectAwardBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The rejected award.", schema: awardSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const revokeAwardDef = createRoute({
  method: "post",
  path: "/api/finance/scholarship-awards/{awardId}/revoke",
  tags: ["Finance"],
  operationId: "revokeScholarshipAward",
  summary: "Revoke an approved scholarship award (school admin)",
  description:
    "From `approved`. Invoices generated from now on are full price; issued invoices keep their " +
    "discount.",
  security: [{ bearerAuth: [] }],
  request: {
    params: awardIdParamSchema,
    body: { required: true, content: { "application/json": { schema: decideAwardBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The revoked award.", schema: awardSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function scholarshipRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const post = (m: Parameters<typeof onlyMethods>[1]) => onlyMethods(["POST"], m);

  routes.use("/api/finance/scholarships", post(auditAction("insert", "scholarships")));
  routes.use(
    "/api/finance/scholarships/:scholarshipId",
    onlyMethods(["PATCH"], auditAction("update", "scholarships")),
  );
  routes.use("/api/finance/scholarship-awards", post(auditAction("insert", "scholarship_awards")));
  routes.use(
    "/api/finance/scholarship-awards/:awardId/approve",
    auditAction("update", "scholarship_awards"),
  );
  routes.use(
    "/api/finance/scholarship-awards/:awardId/reject",
    auditAction("update", "scholarship_awards"),
  );
  routes.use(
    "/api/finance/scholarship-awards/:awardId/revoke",
    auditAction("update", "scholarship_awards"),
  );

  // Reading is billing:read; requesting is billing:update; deciding an award is
  // billing:approveScholarship, which only school leadership (ORG_ADMIN) holds. Both the bare path
  // and "/*" are guarded (see refunds/routes.ts on Hono's "prefix/*").
  routes.use("/api/finance/scholarships", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use("/api/finance/scholarships/*", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use("/api/finance/scholarship-awards", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use("/api/finance/scholarship-awards/*", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use("/api/finance/scholarships", post(requirePermission(PERMISSIONS.BILLING_UPDATE)));
  routes.use(
    "/api/finance/scholarships/:scholarshipId",
    onlyMethods(["PATCH"], requirePermission(PERMISSIONS.BILLING_UPDATE)),
  );
  routes.use(
    "/api/finance/scholarship-awards",
    post(requirePermission(PERMISSIONS.BILLING_UPDATE)),
  );
  routes.use(
    "/api/finance/scholarship-awards/:awardId/approve",
    requirePermission(PERMISSIONS.BILLING_APPROVE_SCHOLARSHIP),
  );
  routes.use(
    "/api/finance/scholarship-awards/:awardId/reject",
    requirePermission(PERMISSIONS.BILLING_APPROVE_SCHOLARSHIP),
  );
  routes.use(
    "/api/finance/scholarship-awards/:awardId/revoke",
    requirePermission(PERMISSIONS.BILLING_APPROVE_SCHOLARSHIP),
  );

  routes.openapi(listScholarshipsDef, async (c) => {
    const tenant = tenantFrom(c);
    const { rows, total } = await withTenantTx(database, tenant, (tx) =>
      listScholarships(tx, tenant.schoolId, c.req.valid("query")),
    );
    return c.json({ scholarships: rows, total }, 200);
  });

  routes.openapi(createScholarshipDef, async (c) => {
    const tenant = tenantFrom(c);
    const row = await withTenantTx(database, tenant, (tx) =>
      createScholarship(tx, tenant.schoolId, tenant.userId, c.req.valid("json")),
    );
    return c.json(row, 201);
  });

  routes.openapi(updateScholarshipDef, async (c) => {
    const tenant = tenantFrom(c);
    const { scholarshipId } = c.req.valid("param");
    const row = await withTenantTx(database, tenant, (tx) =>
      updateScholarship(tx, tenant.schoolId, scholarshipId, c.req.valid("json")),
    );
    return c.json(row, 200);
  });

  routes.openapi(listAwardsDef, async (c) => {
    const { schoolId } = tenantFrom(c);
    const { rows, total } = await withStudentIdentityTx(database, schoolId, (tx) =>
      listAwards(tx, schoolId, c.req.valid("query")),
    );
    return c.json({ awards: rows, total }, 200);
  });

  routes.openapi(createAwardDef, async (c) => {
    const tenant = tenantFrom(c);
    const awardId = await withTenantTx(database, tenant, (tx) =>
      createAward(tx, tenant.schoolId, tenant.userId, c.req.valid("json")),
    );
    const row = await withStudentIdentityTx(database, tenant.schoolId, (tx) =>
      getAward(tx, tenant.schoolId, awardId),
    );
    return c.json(row, 201);
  });

  async function decide(
    c: Context<AppEnv>,
    awardId: string,
    decision: "approve" | "reject" | "revoke",
    notes: string | undefined,
  ) {
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      decideAward(tx, tenant.schoolId, tenant.userId, awardId, decision, notes),
    );
    return withStudentIdentityTx(database, tenant.schoolId, (tx) =>
      getAward(tx, tenant.schoolId, awardId),
    );
  }

  routes.openapi(approveAwardDef, async (c) => {
    const { awardId } = c.req.valid("param");
    return c.json(await decide(c, awardId, "approve", c.req.valid("json").notes), 200);
  });

  routes.openapi(rejectAwardDef, async (c) => {
    const { awardId } = c.req.valid("param");
    return c.json(await decide(c, awardId, "reject", c.req.valid("json").notes), 200);
  });

  routes.openapi(revokeAwardDef, async (c) => {
    const { awardId } = c.req.valid("param");
    return c.json(await decide(c, awardId, "revoke", c.req.valid("json").notes), 200);
  });

  return routes;
}
