import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { hasPermission, requirePermission, requirePermissionIn } from "../../middleware/authz";
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
 * `GET` (history) is gated on `notification:manage` — only SUPER_ADMIN and ORG_ADMIN hold it
 * (`packages/constants/src/permissions.ts`), the same narrower-than-the-admin-dashboard-default
 * pattern the audit explorer uses (see `apps/api/src/modules/audit/routes.ts`).
 *
 * `POST` (compose) additionally accepts the scoped teacher path (ST-238): a caller holding
 * `notification:send` but not `notification:manage` may compose, but only a non-mandatory notice to
 * a class they teach — enforced in `createAnnouncement` via `restrictToTaughtClass`, because the
 * rule needs the parsed body. An admin holding `notification:manage` keeps the full surface.
 */
export function announcementRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // History is admin-only; compose has its own per-request gate in the handler below.
  const manageOnly = requirePermission(PERMISSIONS.NOTIFICATION_MANAGE);
  routes.use("/api/announcements", (c, next) =>
    c.req.method === "GET" ? manageOnly(c, next) : next(),
  );
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

    // notification:manage => full authority (any audience, mandatory allowed). Otherwise the caller
    // must hold notification:send and createAnnouncement applies the scoped teacher rules.
    const scoped = !hasPermission(auth.roles, PERMISSIONS.NOTIFICATION_MANAGE);
    if (scoped) requirePermissionIn(c, PERMISSIONS.NOTIFICATION_SEND);

    const announcement = await withTenantTx(database, tenantFrom(c), (tx) =>
      createAnnouncement(tx, auth.schoolId, auth.userId, body, new Date(), {
        restrictToTaughtClass: scoped,
      }),
    );

    return c.json(announcement, 201);
  });

  return routes;
}
