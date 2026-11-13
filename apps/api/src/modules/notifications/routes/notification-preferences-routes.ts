import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { getPreferences, updatePreferences } from "../notification-preferences-service";
import { createTestNotification, getQuietHours, setQuietHours } from "../quiet-hours-service";
import {
  notificationPreferencesResponseSchema,
  notificationQuietHoursSchema,
  testNotificationResultSchema,
  updateNotificationPreferencesRequestSchema,
  updateNotificationQuietHoursRequestSchema,
} from "../schemas";

import { tenantFrom } from "./notification-routes";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";

/** The test notice's text, in the caller's language. */
const TEST_NOTIFICATION_TEXT: Record<string, { title: string; body: string }> = {
  en: {
    title: "Test notification",
    body: "Notifications are working on this phone.",
  },
  ar: {
    title: "إشعار تجريبي",
    body: "الإشعارات تعمل على هذا الهاتف.",
  },
};

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

const getQuietHoursRoute = createRoute({
  method: "get",
  path: "/api/notification-preferences/quiet-hours",
  tags: ["Notifications"],
  operationId: "getNotificationQuietHours",
  summary: "Get quiet hours",
  description:
    "The caller's quiet hours: a daily window in which phone notifications wait, except urgent " +
    "ones. Both times are null when quiet hours are off.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The current quiet hours.", schema: notificationQuietHoursSchema } },
    [401, 429, 500],
  ),
});

const updateQuietHoursRoute = createRoute({
  method: "put",
  path: "/api/notification-preferences/quiet-hours",
  tags: ["Notifications"],
  operationId: "updateNotificationQuietHours",
  summary: "Set quiet hours",
  description: "Set the caller's quiet window (both times), or turn it off (both null).",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: updateNotificationQuietHoursRequestSchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The quiet hours now in force.", schema: notificationQuietHoursSchema } },
    [400, 401, 429, 500],
  ),
});

const sendTestNotificationRoute = createRoute({
  method: "post",
  path: "/api/notifications/test",
  tags: ["Notifications"],
  operationId: "sendTestNotification",
  summary: "Send a test notification",
  description:
    "Adds a test notice to the caller's inbox; within a few seconds it is pushed to every phone " +
    "the caller is signed in on, whatever their switches and quiet hours say. One per 20 seconds.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 201: { description: "The test notice was queued.", schema: testNotificationResultSchema } },
    [401, 429, 500],
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
  routes.use(
    "/api/notification-preferences/quiet-hours",
    auditAction("update", "user_notification_settings"),
  );
  routes.use("/api/notifications/test", auditAction("insert", "notifications"));

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

  routes.openapi(getQuietHoursRoute, async (c) => {
    const auth = requireAuth(c);
    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      getQuietHours(tx, auth.schoolId, auth.userId),
    );
    return c.json(result, 200);
  });

  routes.openapi(updateQuietHoursRoute, async (c) => {
    const auth = requireAuth(c);
    const { start, end } = c.req.valid("json");
    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      setQuietHours(tx, auth.schoolId, auth.userId, { start, end }),
    );
    return c.json(result, 200);
  });

  routes.openapi(sendTestNotificationRoute, async (c) => {
    const auth = requireAuth(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;
    const text = TEST_NOTIFICATION_TEXT[locale] ?? TEST_NOTIFICATION_TEXT.en;
    const created = await withTenantTx(database, tenantFrom(c), (tx) =>
      createTestNotification(tx, auth.schoolId, auth.userId, text),
    );
    if (created === null) {
      throw new CodedHttpException(
        429,
        ERROR_CODES.RATE_LIMIT_EXCEEDED,
        getLocalizedMessage(ERROR_CODES.RATE_LIMIT_EXCEEDED, locale),
      );
    }
    return c.json({ notification_id: created.id }, 201);
  });

  return routes;
}
