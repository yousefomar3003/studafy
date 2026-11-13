import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import { taxSettingsSchema, updateTaxSettingsBodySchema } from "./schemas";
import { getTaxSettings, saveTaxSettings } from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

const PATH = "/api/finance/tax-settings";

const getSettingsDef = createRoute({
  method: "get",
  path: PATH,
  tags: ["Finance"],
  operationId: "getTaxSettings",
  summary: "Read the school's sales tax (VAT) settings",
  description:
    "Off by default. When on, the billing worker adds the rate to every invoice it generates " +
    "(an ERPNext tax row on the net total) except lines in an exempt fee category, and invoices " +
    "and receipts show the registration number. Invoices already issued are never changed.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The settings.", schema: taxSettingsSchema } },
    [401, 403, 500],
  ),
});

const updateSettingsDef = createRoute({
  method: "put",
  path: PATH,
  tags: ["Finance"],
  operationId: "updateTaxSettings",
  summary: "Replace the school's sales tax (VAT) settings",
  description:
    "Whether and how much tax a school charges is the school's legal decision, so saving needs " +
    "`organization:manageSettings` (the school admin), not the finance team's `billing:update`. " +
    "Turning tax on needs a rate above 0 and the ERPNext account it posts to.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: updateTaxSettingsBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The saved settings.", schema: taxSettingsSchema } },
    [400, 401, 403, 500],
  ),
});

export function taxSettingsRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(PATH, requirePermission(PERMISSIONS.BILLING_READ));
  routes.use(PATH, onlyMethods(["PUT"], auditAction("update", "school_tax_settings")));
  routes.use(
    PATH,
    onlyMethods(["PUT"], requirePermission(PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS)),
  );

  routes.openapi(getSettingsDef, async (c) => {
    const auth = requireAuth(c);
    const settings = await withTenantTx(
      database,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) => getTaxSettings(tx, auth.schoolId),
    );
    return c.json(settings, 200);
  });

  routes.openapi(updateSettingsDef, async (c) => {
    const auth = requireAuth(c);
    const settings = await withTenantTx(
      database,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      async (tx) => {
        await saveTaxSettings(tx, auth.schoolId, auth.userId, c.req.valid("json"));
        return getTaxSettings(tx, auth.schoolId);
      },
    );
    return c.json(settings, 200);
  });

  return routes;
}
