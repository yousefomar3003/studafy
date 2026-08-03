import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  countUnread,
  listNotifications,
  markAllRead,
  markNotificationRead,
} from "../notification-service";
import {
  notificationIdParamSchema,
  notificationListQuerySchema,
  notificationListSchema,
  unreadCountSchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listNotificationsRoute = createRoute({
  method: "get",
  path: "/api/notifications",
  tags: ["Notifications"],
  operationId: "listNotifications",
  summary: "List inbox notifications",
  description:
    "Keyset-paginated list of the authenticated user's notifications, newest first. Optionally " +
    "narrowed to the unread ones.",
  security: [{ bearerAuth: [] }],
  request: { query: notificationListQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of notifications.",
        schema: notificationListSchema,
      },
    },
    [400, 401, 429, 500],
  ),
});

const getUnreadCountRoute = createRoute({
  method: "get",
  path: "/api/notifications/unread-count",
  tags: ["Notifications"],
  operationId: "getUnreadCount",
  summary: "Get unread count",
  description:
    "The authenticated user's number of unread notifications. This is the value a badge renders; " +
    "it is also returned by every read-state mutation so a client can update synchronously.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "Unread count.",
        schema: unreadCountSchema,
      },
    },
    [401, 429, 500],
  ),
});

const markNotificationReadRoute = createRoute({
  method: "post",
  path: "/api/notifications/{notificationId}/read",
  tags: ["Notifications"],
  operationId: "markNotificationRead",
  summary: "Mark a notification read",
  description:
    "Marks a single notification read. Idempotent: marking an already-read notification succeeds " +
    "and returns the current unread count.",
  security: [{ bearerAuth: [] }],
  request: { params: notificationIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Updated unread count.",
        schema: unreadCountSchema,
      },
    },
    [400, 401, 404, 429, 500],
  ),
});

const markAllReadRoute = createRoute({
  method: "post",
  path: "/api/notifications/read-all",
  tags: ["Notifications"],
  operationId: "markAllRead",
  summary: "Mark all notifications read",
  description:
    "Marks every unread notification of the authenticated user as read. Returns the updated " +
    "unread count (zero, absent a concurrent delivery).",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "Updated unread count.",
        schema: unreadCountSchema,
      },
    },
    [401, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * The in-app inbox (ST-142).
 *
 * Deliberately no permission or channel guard. The inbox is personal by construction: RLS
 * (`notifications_owner_*` policies in 000017) already restricts every row to
 * `user_id = app.current_user_id()`, so no role can see or touch anyone else's row regardless of
 * permissions, and marking read from a mobile session must work exactly as well as from a web one.
 * The two read-state mutations are self-service on the caller's own rows and are therefore exempt
 * from requirePermission() (permission-guard-coverage.test.ts), but they do declare an audit action
 * below; the app.audit_logs rows are written from inside the service transactions, alongside the
 * outbox events.
 *
 * Every mutation returns the fresh `unread_count` so the acting client's badge updates
 * synchronously. Cross-device updates are the job of the `notification.read` / `notification.allRead`
 * outbox events this module raises in the same transaction as the read-state change; a consumer that
 * fans them out to the recipient's clients (per-user realtime or a badge data push) is a separate
 * ticket, because the realtime gateway today only fans out to `school:{id}:role:{role}` rooms, which
 * cannot carry one user's read state to the same user's other devices without leaking it to the rest
 * of the role.
 */
export function notificationRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/notifications/{notificationId}/read", auditAction("update", "notifications"));
  routes.use("/api/notifications/read-all", auditAction("update", "notifications"));

  routes.openapi(listNotificationsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listNotifications(tx, auth.schoolId, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        unreadOnly: query.unread_only === "true",
      }),
    );

    return c.json({ notifications: rows, next_cursor }, 200);
  });

  routes.openapi(getUnreadCountRoute, async (c) => {
    const auth = requireAuth(c);

    const unread_count = await withTenantTx(database, tenantFrom(c), (tx) =>
      countUnread(tx, auth.schoolId),
    );

    return c.json({ unread_count }, 200);
  });

  routes.openapi(markNotificationReadRoute, async (c) => {
    const auth = requireAuth(c);
    const { notificationId } = c.req.valid("param");

    const unread_count = await withTenantTx(database, tenantFrom(c), (tx) =>
      markNotificationRead(tx, auth.schoolId, auth.userId, notificationId),
    );

    return c.json({ unread_count }, 200);
  });

  routes.openapi(markAllReadRoute, async (c) => {
    const auth = requireAuth(c);

    const unread_count = await withTenantTx(database, tenantFrom(c), (tx) =>
      markAllRead(tx, auth.schoolId, auth.userId),
    );

    return c.json({ unread_count }, 200);
  });

  return routes;
}
