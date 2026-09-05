import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import {
  provisioningStatusPathParams,
  provisioningStatusResponseSchema,
  triggerProvisioningResponseSchema,
} from "./schemas";
import { getProvisioningStatus } from "./service";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getProvisioningStatusRoute = createRoute({
  method: "get",
  path: "/api/schools/{schoolId}/provisioning-status",
  tags: ["Schools"],
  operationId: "getProvisioningStatus",
  security: [{ bearerAuth: [] }],
  summary: "Get provisioning status for a school",
  description:
    "Returns the current provisioning status including trial subscription details and " +
    "ERPNext site/company configuration. Requires school admin privileges.",
  request: { params: provisioningStatusPathParams },
  responses: standardResponses(
    {
      200: {
        description: "Provisioning status returned.",
        schema: provisioningStatusResponseSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const triggerProvisioningRoute = createRoute({
  method: "post",
  path: "/api/schools/{schoolId}/provision",
  tags: ["Schools"],
  operationId: "triggerProvisioning",
  security: [{ bearerAuth: [] }],
  summary: "Trigger tenant provisioning",
  description:
    "Manually triggers the full provisioning pipeline for a school. Idempotent — " +
    "retries with the same schoolId return the existing state without duplicating rows.",
  request: { params: provisioningStatusPathParams },
  responses: standardResponses(
    {
      200: {
        description: "Provisioning triggered or already complete.",
        schema: triggerProvisioningResponseSchema,
      },
    },
    [401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the provisioning route group.
 *
 * Authenticated (requires school admin permissions). Requires: database, logger.
 */
export function provisioningRoutes(db: Database, _logger: Logger): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/schools/:schoolId/provisioning-status", auditAction("update", "schools"));
  routes.use("/api/schools/:schoolId/provision", auditAction("update", "schools"));

  routes.openapi(getProvisioningStatusRoute, async (c) => {
    const { schoolId } = c.req.valid("param");

    const result = await getProvisioningStatus(db, schoolId);

    return c.json(
      {
        schoolId: result.schoolId,
        status: result.status,
        erpNextSite: result.erpNextSite ?? null,
      },
      200,
    );
  });

  routes.openapi(triggerProvisioningRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const log = c.get("log");
    const auth = requireAuth(c);

    // Read school info for provisioning params.
    const schools = await db<
      { slug: string; name: string; country_id: string; default_currency_id: string }[]
    >`
      SELECT slug, name, country_id, default_currency_id
      FROM app.schools
      WHERE id = ${schoolId}::uuid
      LIMIT 1
    `;

    if (schools.length === 0) {
      throw new CodedHttpException(404, "RESOURCE_NOT_FOUND" as never, "School not found.");
    }

    const school = schools[0];

    const { provisionTenant } = await import("./service");

    const result = await provisionTenant(
      db,
      {
        schoolId,
        slug: school.slug,
        schoolName: school.name,
        countryId: school.country_id,
        country: "",
        defaultCurrencyId: school.default_currency_id,
        currency: "",
        adminUserId: auth.userId,
        adminEmail: "",
        tenantContext: { schoolId, userId: auth.userId },
      },
      log,
      null,
    );

    return c.json(
      {
        schoolId: result.schoolId,
        status: result.status,
      },
      200,
    );
  });

  return routes;
}
