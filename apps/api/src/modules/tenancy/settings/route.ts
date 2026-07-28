import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";

import { updateSchoolSettingsBodySchema, schoolSettingsResponseSchema } from "./schemas";
import { getSchoolSettings, updateSchoolSettings } from "./service";

import type { SchoolSettingsRow } from "./service";
import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { z } from "@hono/zod-openapi";

type SchoolSettingsResponse = z.infer<typeof schoolSettingsResponseSchema>;

function formatSettingsResponse(row: SchoolSettingsRow): SchoolSettingsResponse {
  return {
    locale: row.locale as SchoolSettingsResponse["locale"],
    timezone: row.timezone,
    grading_scheme: row.grading_scheme as SchoolSettingsResponse["grading_scheme"],
    invitation_expiry_days: row.invitation_expiry_days,
    attendance_alert_threshold: row.attendance_alert_threshold,
    absence_alert_threshold: row.absence_alert_threshold,
    parent_discipline_visibility: row.parent_discipline_visibility,
    created_at:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getSettingsRoute = createRoute({
  method: "get",
  path: "/api/schools/current/settings",
  tags: ["Schools"],
  operationId: "getSchoolSettings",
  summary: "Get current school settings",
  description:
    "Returns the authenticated school's configuration: locale, timezone, grading scheme, " +
    "invitation expiry, and attendance alert thresholds. Creates a default settings row " +
    "on first access.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Current school settings.", schema: schoolSettingsResponseSchema } },
    [401, 403, 429, 500],
  ),
});

const updateSettingsRoute = createRoute({
  method: "patch",
  path: "/api/schools/current/settings",
  tags: ["Schools"],
  operationId: "updateSchoolSettings",
  summary: "Update school settings",
  description:
    "Partially update the school's configuration. Only provided fields are changed; " +
    "omitted fields retain their current values. Every mutation is audited with full " +
    "before/after snapshots.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: updateSchoolSettingsBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "Updated school settings.", schema: schoolSettingsResponseSchema } },
    [400, 401, 403, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the school settings route group.
 *
 * Authenticated, admin-only (ORGANIZATION_MANAGE_SETTINGS). Web-channel only.
 * Requires a database for settings CRUD and audit logging.
 */
export function schoolSettingsRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const basePath = "/api/schools/current/settings";

  // Web-channel only for settings mutations.
  const channelGuard = requireChannel(AUTH_CHANNELS.WEB);
  routes.use(basePath, channelGuard);

  // Admin-only permission guard.
  const guard = requirePermission(PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS);
  routes.use(basePath, guard);

  // Audit metadata for CI coverage check.
  routes.use(basePath, auditAction("update", "school_settings"));

  routes.openapi(getSettingsRoute, async (c) => {
    const auth = requireAuth(c);
    const row = await getSchoolSettings(database, auth.schoolId);
    return c.json(formatSettingsResponse(row), 200);
  });

  routes.openapi(updateSettingsRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const row = await updateSchoolSettings(database, auth.schoolId, body);
    return c.json(formatSettingsResponse(row), 200);
  });

  return routes;
}
