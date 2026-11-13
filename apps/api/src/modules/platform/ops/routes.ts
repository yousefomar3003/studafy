import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";

import { listPlatformActivity, listPlatformOperators } from "./activity-service";
import {
  createAnnouncement,
  listActiveBanners,
  listAnnouncements,
  updateAnnouncement,
} from "./announcements-service";
import { listFlagsAcrossSchools } from "./flags-overview-service";
import { getSystemHealth } from "./health-service";
import {
  activeBannerListSchema,
  activityListSchema,
  activityQuerySchema,
  announcementIdParamSchema,
  announcementListQuerySchema,
  announcementListSchema,
  announcementSchema,
  createAnnouncementBodySchema,
  flagOverviewListSchema,
  platformOperatorListSchema,
  systemHealthSchema,
  updateAnnouncementBodySchema,
} from "./schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { FlagsService } from "../../flags";
import type { Actor } from "../service";
import type { Context } from "hono";

const TAG = "Platform";
const DEFAULT_ACTIVITY_DAYS = 30;

const listAnnouncementsRoute = createRoute({
  method: "get",
  path: "/api/platform/announcements",
  tags: [TAG],
  operationId: "listPlatformAnnouncements",
  summary: "Studafy-wide banners",
  description:
    "Live and scheduled announcements, then the most recent ended ones. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { query: announcementListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Announcements.", schema: announcementListSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const createAnnouncementRoute = createRoute({
  method: "post",
  path: "/api/platform/announcements",
  tags: [TAG],
  operationId: "createPlatformAnnouncement",
  summary: "Schedule a Studafy-wide banner",
  description:
    "A message (English, optional Arabic) shown to every signed-in user or only to school staff " +
    "between `startsAt` and `endsAt`. Maintenance banners can't be dismissed. The reason is " +
    "recorded in the audit log. platform:manage.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createAnnouncementBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The announcement.", schema: announcementSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const updateAnnouncementRoute = createRoute({
  method: "patch",
  path: "/api/platform/announcements/{announcementId}",
  tags: [TAG],
  operationId: "updatePlatformAnnouncement",
  summary: "Change or end a banner",
  description:
    "Edit a live or scheduled announcement, or end it now with `endNow`. Ended announcements are " +
    "kept as history and can't change (409). The reason is recorded in the audit log. " +
    "platform:manage.",
  security: [{ bearerAuth: [] }],
  request: {
    params: announcementIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateAnnouncementBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The announcement.", schema: announcementSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const activeBannersRoute = createRoute({
  method: "get",
  path: "/api/platform-banners",
  tags: [TAG],
  operationId: "listPlatformBanners",
  summary: "Banners live for the signed-in user",
  description:
    "The Studafy-wide announcements in their window right now whose audience includes the caller " +
    "(every user, or school staff), most severe first. Any signed-in user, web or mobile.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Live banners.", schema: activeBannerListSchema } },
    [401, 429, 500],
  ),
});

const activityRoute = createRoute({
  method: "get",
  path: "/api/platform/activity",
  tags: [TAG],
  operationId: "listPlatformActivity",
  summary: "What Studafy staff did, across every school",
  description:
    "Audit rows written by SUPER_ADMIN and SUPPORT_AGENT accounts, newest first, with the school " +
    "each action changed. Filter by operator, action, table, affected school and date range " +
    "(default: the last 30 days; at most a year). Keyset-paged. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { query: activityQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of activity.", schema: activityListSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const operatorsRoute = createRoute({
  method: "get",
  path: "/api/platform/activity/operators",
  tags: [TAG],
  operationId: "listPlatformOperators",
  summary: "Studafy staff accounts",
  description: "Every SUPER_ADMIN and SUPPORT_AGENT account, for the activity log's filter.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Operators.", schema: platformOperatorListSchema } },
    [401, 403, 429, 500],
  ),
});

const healthRoute = createRoute({
  method: "get",
  path: "/api/platform/health",
  tags: [TAG],
  operationId: "getPlatformSystemHealth",
  summary: "System health",
  description:
    "Read-only: background job counts, failures and scheduled runs; notification dead letters; " +
    "payment webhook failures and rejected signatures; email bounces and complaints; and the " +
    "latest storage reconciliation with its per-school orphan report, all from what the platform " +
    "already records. Signals it doesn't record are listed in `notAvailable`. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "System health.", schema: systemHealthSchema } },
    [401, 403, 429, 500],
  ),
});

const flagsRoute = createRoute({
  method: "get",
  path: "/api/platform/feature-flags",
  tags: [TAG],
  operationId: "listPlatformFeatureFlags",
  summary: "Every feature flag across every school",
  description:
    "Each flag's deployment default and the schools that override it. Overrides are changed per " +
    "school; there is no database-held global default. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Flags.", schema: flagOverviewListSchema } },
    [401, 403, 429, 500],
  ),
});

export interface PlatformOpsRoutesDeps {
  database: Database;
  redis: RedisClient | null;
  flags: FlagsService | null;
}

function actorFrom(c: Context<AppEnv>): Actor {
  const auth = requireAuth(c);
  return { userId: auth.userId, schoolId: auth.schoolId, requestId: c.get("requestId") };
}

/**
 * Platform console operations: announcements, the staff activity log, system health and the
 * cross-school flag view (`/api/platform/*`, web, platform:read; writes platform:manage), plus the
 * banner read every signed-in client makes (`/api/platform-banners`, any role and channel).
 */
export function platformOpsRoutes(deps: PlatformOpsRoutesDeps): OpenAPIHono<AppEnv> {
  const { database, redis, flags } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const read = requirePermission(PERMISSIONS.PLATFORM_READ);
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  const web = requireChannel(AUTH_CHANNELS.WEB);

  for (const path of [
    "/api/platform/announcements",
    "/api/platform/announcements/*",
    "/api/platform/activity",
    "/api/platform/activity/*",
    "/api/platform/health",
    "/api/platform/feature-flags",
  ]) {
    routes.use(path, web, read);
  }
  routes.use("/api/platform/announcements", async (c, next) =>
    c.req.method === "GET" ? next() : manage(c, next),
  );
  routes.use("/api/platform/announcements/:announcementId", manage);
  routes.use("/api/platform/announcements", async (c, next) =>
    c.req.method === "POST" ? auditAction("insert", "platform_announcements")(c, next) : next(),
  );
  routes.use(
    "/api/platform/announcements/:announcementId",
    auditAction("update", "platform_announcements"),
  );

  routes.openapi(listAnnouncementsRoute, async (c) => {
    const { limit } = c.req.valid("query");
    return c.json({ announcements: await listAnnouncements(database, { limit }) }, 200);
  });

  routes.openapi(createAnnouncementRoute, async (c) => {
    const body = c.req.valid("json");
    const announcement = await createAnnouncement(
      database,
      {
        messageEn: body.messageEn,
        messageAr: body.messageAr ?? null,
        audience: body.audience,
        severity: body.severity,
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        reason: body.reason,
      },
      actorFrom(c),
    );
    return c.json(announcement, 201);
  });

  routes.openapi(updateAnnouncementRoute, async (c) => {
    const { announcementId } = c.req.valid("param");
    const body = c.req.valid("json");
    const announcement = await updateAnnouncement(
      database,
      announcementId,
      {
        messageEn: body.messageEn,
        messageAr: body.messageAr,
        audience: body.audience,
        severity: body.severity,
        startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
        endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
        endNow: body.endNow,
        reason: body.reason,
      },
      actorFrom(c),
    );
    return c.json(announcement, 200);
  });

  routes.openapi(activeBannersRoute, async (c) => {
    const auth = requireAuth(c);
    return c.json({ banners: await listActiveBanners(database, auth.roles) }, 200);
  });

  routes.openapi(activityRoute, async (c) => {
    const query = c.req.valid("query");
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DEFAULT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000);
    return c.json(
      await listPlatformActivity(database, {
        from,
        to,
        actorId: query.actorId,
        action: query.action,
        targetTable: query.targetTable,
        schoolId: query.schoolId,
        limit: query.limit,
        cursor: query.cursor,
      }),
      200,
    );
  });

  routes.openapi(operatorsRoute, async (c) =>
    c.json({ operators: await listPlatformOperators(database) }, 200),
  );

  routes.openapi(healthRoute, async (c) => c.json(await getSystemHealth(database, redis), 200));

  routes.openapi(flagsRoute, async (c) =>
    c.json({ flags: await listFlagsAcrossSchools(database, flags) }, 200),
  );

  return routes;
}
