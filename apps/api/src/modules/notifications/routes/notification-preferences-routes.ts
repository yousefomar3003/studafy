import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { getPreferences, updatePreferences } from "../notification-preferences-service";
import {
  notificationPreferencesResponseSchema,
  updateNotificationPreferencesRequestSchema,
} from "../schemas";

import { tenantFrom } from "./notification-routes";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getPreferencesRoute = createRoute({
  method: "get",
  path: "/api/notification-preferences",
  tags: ["Notifications"],
  operationId: "getNotificationPreferences",
  summary: "Get notification preferences",
  description:
    "The authenticated user's full per-type, per-channel notification preference matrix, plus " +
    "their personal attendance-alert threshold override. Every type-channel pair is represented, " +
    "including ones the user has never touched — those default to enabled and non-digest.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "The current preference matrix.",
        schema: notificationPreferencesResponseSchema,
      },
    },
    [401, 429, 500],
  ),
});

const updatePreferencesRoute = createRoute({
  method: "patch",
  path: "/api/notification-preferences",
  tags: ["Notifications"],
  operationId: "updateNotificationPreferences",
  summary: "Update notification preferences",
  description:
    "Toggle channels, set digest mode on eligible types, and/or set a personal attendance-alert " +
    "threshold. Unlisted (type, channel) cells are left unchanged. Disabling a mandatory type, or " +
    "enabling digest on a non-email channel or a non-eligible type, fails with 422.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: updateNotificationPreferencesRequestSchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The preference matrix after applying the update.",
        schema: notificationPreferencesResponseSchema,
      },
    },
    [400, 401, 422, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Notification preferences (ST-143).
 *
 * Self-service on the caller's own rows, same as the inbox routes in notification-routes.ts:
 * notification_preferences_owner (000017) restricts every row to `user_id = app.current_user_id()`
 * regardless of permissions, so there is no other user's row this could reach and no
 * requirePermission() to add (see permission-guard-coverage.test.ts's GUARD_EXEMPT_ROUTES).
 *
 * The mandatory-type and digest-eligibility rules are enforced twice on purpose: once here for a
 * clean 422 with a message naming the rule, and again by ck_notification_preferences_mandatory_enabled
 * / ck_notification_preferences_digest_channel / ck_notification_preferences_digest_eligible
 * (migration 000083), which is what makes the rule true regardless of caller, not just of this route.
 */
export function notificationPreferencesRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/notification-preferences", auditAction("update", "notification_preferences"));

  routes.openapi(getPreferencesRoute, async (c) => {
    const auth = requireAuth(c);

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      getPreferences(tx, auth.userId),
    );

    return c.json(result, 200);
  });

  routes.openapi(updatePreferencesRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      updatePreferences(tx, auth.schoolId, auth.userId, body),
    );

    return c.json(result, 200);
  });

  return routes;
}
