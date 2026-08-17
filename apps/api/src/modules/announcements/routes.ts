import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import {
  announcementListQuerySchema,
  announcementListSchema,
  announcementSchema,
  createAnnouncementBodySchema,
} from "./schemas";
import { createAnnouncement, listAnnouncements } from "./service";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

const listAnnouncementsRoute = createRoute({
  method: "get",
  path: "/api/announcements",
  tags: ["Announcements"],
  operationId: "listAnnouncements",
  summary: "List the school's announcements",
  description:
    "Keyset-paginated history, newest first, with each row's reach stats (recipient_count / " +
    "notified_count) joined in.",
  security: [{ bearerAuth: [] }],
  request: { query: announcementListQuerySchema },
  responses: standardResponses(
    { 200: { description: "A page of announcements.", schema: announcementListSchema } },
    [400, 401, 403, 500],
  ),
});

const createAnnouncementRoute = createRoute({
  method: "post",
  path: "/api/announcements",
  tags: ["Announcements"],
  operationId: "createAnnouncement",
  summary: "Compose an announcement",
  description:
    "Creates an announcement targeted at a school, role, or class audience. Publishes immediately " +
    "in the same transaction when scheduled_at is omitted or already due; otherwise leaves it for " +
    "the scheduled-publish sweep.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createAnnouncementBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created (and possibly already-published) announcement.",
        schema: announcementSchema,
      },
    },
    [400, 401, 403, 404, 500],
  ),
});

/**
 * Announcement management (ST-194): compose/publish with audience targeting (school/role/class) and
 * a mandatory flag, scheduled publishing, and history with reach stats.
 *
 * Gated on `notification:manage` rather than `organization:manageSettings` — the same
 * narrower-than-the-admin-dashboard-default pattern the audit explorer uses (see
 * `apps/api/src/modules/audit/routes.ts`). Only SUPER_ADMIN and ORG_ADMIN hold it
 * (`packages/constants/src/permissions.ts`), which is also exactly the role set `notification:manage`
 * was added for: the comment on NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT in
 * packages/constants/src/notifications.ts says this producer didn't exist yet — it does now.
 */
export function announcementRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/announcements", requirePermission(PERMISSIONS.NOTIFICATION_MANAGE));
  routes.use("/api/announcements", auditAction("insert", "announcements"));

  routes.openapi(listAnnouncementsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { items, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listAnnouncements(tx, auth.schoolId, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      }),
    );

    return c.json({ items, next_cursor }, 200);
  });

  routes.openapi(createAnnouncementRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const announcement = await withTenantTx(database, tenantFrom(c), (tx) =>
      createAnnouncement(tx, auth.schoolId, auth.userId, body, new Date()),
    );

    return c.json(announcement, 201);
  });

  return routes;
}
