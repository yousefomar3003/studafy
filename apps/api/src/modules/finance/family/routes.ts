import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { hasPermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { familyCustomers } from "../reports/service";
import { withStudentIdentityTx } from "../students/service";

import { familyFinancialViewParamSchema, familyFinancialViewResponseSchema } from "./schemas";
import { aggregateFamilyFinancialView } from "./service";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";
import type { TransactionSql } from "postgres";

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

const familyFinancialViewRoute = createRoute({
  method: "get",
  path: "/api/finance/families/{familyId}",
  tags: ["Finance"],
  operationId: "getFamilyFinancialView",
  summary: "Serve the family financial view",
  description:
    "Aggregated read-only household view of linked children's invoices, fee-schedule " +
    "installments, and payment receipts, served from the local ERPNext read models. " +
    "pay_online_url is the entry point for the online payment redirect and is present only " +
    "when an invoice still owes money and PAYMENT_REDIRECT_BASE_URL is configured.",
  security: [{ bearerAuth: [] }],
  request: { params: familyFinancialViewParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Family financial view.",
        schema: familyFinancialViewResponseSchema,
      },
    },
    [400, 401, 403, 404, 429, 500, 503],
  ),
});

/**
 * Routes for the parent-facing family financial view (ST-127).
 *
 * The route owns access resolution (`familyCustomers` gates on family membership, with
 * REPORT_VIEW_FINANCIAL as the allow-all for staff) and the service owns pure aggregation over
 * the local read models. The pay-online redirect base is configuration, injected here so the
 * service stays testable and the behaviour is explicit at the wiring site.
 */
export function familyFinancialViewRoutes(
  database: Database,
  payRedirectBaseUrl: string | undefined,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(familyFinancialViewRoute, async (c) => {
    const auth = requireAuth(c);
    const { familyId } = c.req.valid("param");
    const locale = c.get("locale") as SupportedLocale;
    const canViewAll = hasPermission(auth.roles, PERMISSIONS.REPORT_VIEW_FINANCIAL);
    // Finance staff read any family, but cannot see app.students under their role-scope policy, so
    // their read runs with the identity-only access every finance student lookup uses. A parent's
    // read stays on their own tenant transaction, where RLS limits them to their own children.
    const inTx = <T>(fn: (tx: TransactionSql) => Promise<T>) =>
      canViewAll
        ? withStudentIdentityTx(database, auth.schoolId, fn)
        : withTenantTx(database, tenantFrom(c), fn);
    const view = await inTx(async (tx) => {
      const family = await familyCustomers(tx, auth.schoolId, familyId, auth.userId, canViewAll);
      return aggregateFamilyFinancialView(
        tx,
        auth.schoolId,
        familyId,
        family.studentIds,
        locale,
        payRedirectBaseUrl,
      );
    });
    return c.json(view, 200);
  });

  return routes;
}
