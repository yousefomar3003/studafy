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

import { siblingDiscountRuleSchema, updateSiblingDiscountBodySchema } from "./schemas";
import { getSiblingDiscountRule, replaceSiblingDiscountRule } from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

const PATH = "/api/finance/sibling-discount";

const getRuleDef = createRoute({
  method: "get",
  path: PATH,
  tags: ["Finance"],
  operationId: "getSiblingDiscountRule",
  summary: "Read the sibling discount rule",
  description:
    "The school's automatic discount for a family's second and later enrolled children, ranked " +
    "eldest first by date of birth. The billing worker applies it to every invoice it generates, " +
    "adding to the student's approved scholarships; invoices already issued are not changed.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The rule.", schema: siblingDiscountRuleSchema } },
    [401, 403, 500],
  ),
});

const updateRuleDef = createRoute({
  method: "put",
  path: PATH,
  tags: ["Finance"],
  operationId: "updateSiblingDiscountRule",
  summary: "Replace the sibling discount rule",
  description:
    "Replaces the rule and its tiers. A discount is the school's sign-off, so this needs " +
    "`billing:approveScholarship`, the permission that approves a scholarship award.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: updateSiblingDiscountBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The saved rule.", schema: siblingDiscountRuleSchema } },
    [400, 401, 403, 500],
  ),
});

export function siblingDiscountRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(PATH, requirePermission(PERMISSIONS.BILLING_READ));
  routes.use(PATH, onlyMethods(["PUT"], auditAction("update", "sibling_discount_settings")));
  routes.use(
    PATH,
    onlyMethods(["PUT"], requirePermission(PERMISSIONS.BILLING_APPROVE_SCHOLARSHIP)),
  );

  routes.openapi(getRuleDef, async (c) => {
    const { schoolId } = requireAuth(c);
    const rule = await withStudentIdentityTx(database, schoolId, (tx) =>
      getSiblingDiscountRule(tx, schoolId),
    );
    return c.json(rule, 200);
  });

  routes.openapi(updateRuleDef, async (c) => {
    const auth = requireAuth(c);
    await withTenantTx(
      database,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) => replaceSiblingDiscountRule(tx, auth.schoolId, auth.userId, c.req.valid("json")),
    );
    const rule = await withStudentIdentityTx(database, auth.schoolId, (tx) =>
      getSiblingDiscountRule(tx, auth.schoolId),
    );
    return c.json(rule, 200);
  });

  return routes;
}
