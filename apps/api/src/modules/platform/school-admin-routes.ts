import { createRoute } from "@hono/zod-openapi";
import { PERMISSIONS, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { onlyMethods } from "../../middleware/only-methods";
import { standardResponses } from "../../openapi/responses";

import { schoolDetailSchema, schoolIdParamSchema } from "./schemas";
import {
  createSchoolExportBodySchema,
  schoolExportListSchema,
  schoolExportParamSchema,
  schoolExportSchema,
  schoolUsageSchema,
  updateSchoolProfileBodySchema,
} from "./school-admin-schemas";
import {
  createSchoolExport,
  getSchoolExport,
  getSchoolUsage,
  listSchoolExports,
  updateSchoolProfile,
} from "./school-admin-service";

import type { Actor } from "./service";
import type { Database } from "../../db/client";
import type { StorageService } from "../../lib/storage";
import type { AppEnv } from "../../middleware/requestId";
import type { RedisClient } from "../../redis";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";

const TAG = "Platform";

const updateProfileRoute = createRoute({
  method: "patch",
  path: "/api/platform/schools/{schoolId}/profile",
  tags: [TAG],
  operationId: "updatePlatformSchoolProfile",
  summary: "Edit a school's profile",
  description:
    "Changes a school's name, contact email, country, currency, default language or timezone, " +
    "with a reason. Country and currency are refused (409) once the school has billing records " +
    "(a payment-provider customer, licence quotes or invoices, or paid add-ons); an email another " +
    "school uses is refused (409). Unchanged fields are not written. Audited in the school and in " +
    "the operator's own school. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: schoolIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateSchoolProfileBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "Updated school detail.", schema: schoolDetailSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const usageRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/usage",
  tags: [TAG],
  operationId: "getPlatformSchoolUsage",
  summary: "One school's usage",
  description:
    "Active and not-yet-activated accounts per role, open invitations, storage against the cap, " +
    "AI add-ons and this month's feature use, last sign-in, and the active licence's seats " +
    "bought against used. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: schoolIdParamSchema },
  responses: standardResponses(
    { 200: { description: "School usage.", schema: schoolUsageSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const listExportsRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/exports",
  tags: [TAG],
  operationId: "listPlatformSchoolExports",
  summary: "A school's whole-school data exports",
  description:
    "The last 10 exports filed from the console for this school, newest first. Links are only " +
    "issued by the single-export read. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: schoolIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The school's exports.", schema: schoolExportListSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const createExportRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/exports",
  tags: [TAG],
  operationId: "createPlatformSchoolExport",
  summary: "Export a school's data",
  description:
    "Queues a ZIP of every table and stored file the school owns -- the same bundle as the " +
    "closure export. One at a time per school (409 while one is queued or processing). The bundle " +
    "is deleted 30 days after it completes. Never erases anything. Audited. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: schoolIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createSchoolExportBodySchema } },
    },
  },
  responses: standardResponses(
    { 202: { description: "Export queued.", schema: schoolExportSchema } },
    [400, 401, 403, 404, 409, 429, 500, 503],
  ),
});

const getExportRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/exports/{exportId}",
  tags: [TAG],
  operationId: "getPlatformSchoolExport",
  summary: "One export, with its download link",
  description:
    "The export's status and, once it completed and until the retention sweep deletes it, a " +
    "download link valid for one hour. Issuing a link is audited. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: schoolExportParamSchema },
  responses: standardResponses(
    { 200: { description: "The export.", schema: schoolExportSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

export interface SchoolAdminRoutesDeps {
  database: Database;
  redis: RedisClient | null;
  storage: StorageService | null;
}

function actorFrom(c: Context<AppEnv>): Actor {
  const auth = requireAuth(c);
  return { userId: auth.userId, schoolId: auth.schoolId, requestId: c.get("requestId") };
}

/**
 * Mounts the per-school administration routes on the platform console router. The router already
 * applies the web-channel guard and `platform:read` to `/api/platform/*`; writes add
 * `platform:manage` here. Registered by `platformRoutes`, after its own middleware.
 */
export function registerSchoolAdminRoutes(
  routes: OpenAPIHono<AppEnv>,
  deps: SchoolAdminRoutesDeps,
): void {
  const { database, redis, storage } = deps;
  const maintenanceQueue = redis
    ? new Queue(QUEUE_NAMES.MAINTENANCE, { connection: redis as never })
    : null;
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);

  routes.use("/api/platform/schools/:schoolId/profile", manage);
  routes.use("/api/platform/schools/:schoolId/profile", auditAction("update", "schools"));
  // POST files an export (platform:manage); GET lists them (platform:read, from the router).
  routes.use("/api/platform/schools/:schoolId/exports", onlyMethods(["POST"], manage));
  routes.use(
    "/api/platform/schools/:schoolId/exports",
    auditAction("export", "data_subject_requests"),
  );
  // Reading one export issues the download link: manage, and audited as a read.
  routes.use("/api/platform/schools/:schoolId/exports/:exportId", manage);
  routes.use(
    "/api/platform/schools/:schoolId/exports/:exportId",
    auditAction("read", "data_subject_requests"),
  );

  routes.openapi(updateProfileRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const body = c.req.valid("json");
    return c.json(await updateSchoolProfile(database, schoolId, body, actorFrom(c)), 200);
  });

  routes.openapi(usageRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    return c.json(await getSchoolUsage(database, schoolId), 200);
  });

  routes.openapi(listExportsRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    return c.json({ exports: await listSchoolExports(database, schoolId) }, 200);
  });

  routes.openapi(createExportRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const created = await createSchoolExport(
      database,
      maintenanceQueue,
      schoolId,
      reason,
      actorFrom(c),
    );
    return c.json(created, 202);
  });

  routes.openapi(getExportRoute, async (c) => {
    const { schoolId, exportId } = c.req.valid("param");
    return c.json(await getSchoolExport(database, storage, schoolId, exportId, actorFrom(c)), 200);
  });
}
