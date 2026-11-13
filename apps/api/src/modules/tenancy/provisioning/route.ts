import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
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
import type { Context } from "hono";

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
    "Returns the current provisioning status including the school plan details and " +
    "ERPNext site/company configuration. Requires organization:manageSettings, and only for the " +
    "caller's own school.",
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
    "retries with the same schoolId return the existing state without duplicating rows. Requires " +
    "organization:manageSettings, and only for the caller's own school.",
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

/**
 * Refuse a request whose path names a school other than the caller's own (QA-12 / F-03).
 *
 * Provisioning grants `adminUserId` ORG_ADMIN in the target school, so a caller who could point it at
 * any school could make themselves that school's admin. The permission guard alone does not stop
 * that: an ORG_ADMIN of school A holds the permission and would pass it for school B. Answered as
 * 404, the same as a school that does not exist, so the route cannot be used to probe school ids.
 */
function requireOwnSchool(c: Context<AppEnv>, schoolId: string): void {
  const auth = requireAuth(c);
  if (schoolId !== auth.schoolId) {
    c.get("log").warn(
      { event: "cross_school_provisioning_denied", target_school_id: schoolId },
      "caller targeted provisioning for a school other than their own",
    );
    throw new CodedHttpException(404, "RESOURCE_NOT_FOUND" as never, "School not found.");
  }
}

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the provisioning route group.
 *
 * Authenticated. Both routes require ORGANIZATION_MANAGE_SETTINGS (held by ORG_ADMIN and
 * SUPER_ADMIN) and act only on the caller's own school. Requires: database, logger.
 */
export function provisioningRoutes(db: Database, _logger: Logger): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Permission before audit, so a refused call is never recorded as an update to the school.
  const guard = requirePermission(PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS);
  routes.use("/api/schools/:schoolId/provisioning-status", guard);
  routes.use("/api/schools/:schoolId/provision", guard);

  routes.use("/api/schools/:schoolId/provisioning-status", auditAction("update", "schools"));
  routes.use("/api/schools/:schoolId/provision", auditAction("update", "schools"));

  routes.openapi(getProvisioningStatusRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    requireOwnSchool(c, schoolId);

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
    requireOwnSchool(c, schoolId);

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
