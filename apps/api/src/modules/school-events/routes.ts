import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { onlyMethods } from "../../middleware/only-methods";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";

import {
  createSchoolEventBodySchema,
  schoolEventIdParamSchema,
  schoolEventListQuerySchema,
  schoolEventListSchema,
  schoolEventSchema,
  updateSchoolEventBodySchema,
} from "./schemas";
import {
  createSchoolEvent,
  deleteSchoolEvent,
  listSchoolEvents,
  updateSchoolEvent,
} from "./service";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

const TAG = "School calendar";

const listRoute = createRoute({
  method: "get",
  path: "/api/school-events",
  tags: [TAG],
  operationId: "listSchoolEvents",
  summary: "List calendar events in a date window",
  description:
    "Holidays, events, meetings and exam periods overlapping [from, to] (inclusive), in calendar " +
    "order. Terms and class exams are separate resources under /api/academics.",
  security: [{ bearerAuth: [] }],
  request: { query: schoolEventListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Events in the window.", schema: schoolEventListSchema } },
    [400, 401, 403, 500],
  ),
});

const createEventRoute = createRoute({
  method: "post",
  path: "/api/school-events",
  tags: [TAG],
  operationId: "createSchoolEvent",
  summary: "Add a calendar event",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createSchoolEventBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created event.", schema: schoolEventSchema } },
    [400, 401, 403, 500],
  ),
});

const updateEventRoute = createRoute({
  method: "patch",
  path: "/api/school-events/{eventId}",
  tags: [TAG],
  operationId: "updateSchoolEvent",
  summary: "Edit a calendar event",
  security: [{ bearerAuth: [] }],
  request: {
    params: schoolEventIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateSchoolEventBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated event.", schema: schoolEventSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const deleteEventRoute = createRoute({
  method: "delete",
  path: "/api/school-events/{eventId}",
  tags: [TAG],
  operationId: "deleteSchoolEvent",
  summary: "Remove a calendar event",
  security: [{ bearerAuth: [] }],
  request: { params: schoolEventIdParamSchema },
  responses: {
    204: { description: "Removed.", headers: requestIdHeaders },
    ...standardResponses({}, [400, 401, 403, 404, 500]),
  },
});

/**
 * School calendar entries (app.school_events, 000121). Reading takes `calendarEvent:read` (school
 * leadership and teaching staff); adding, editing and removing take `calendarEvent:manage`
 * (PRINCIPAL and ORG_ADMIN). Every mutation is audited by the service.
 */
export function schoolEventRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/school-events", requirePermission(PERMISSIONS.CALENDAR_EVENT_READ));
  routes.use(
    "/api/school-events",
    onlyMethods(["POST"], requirePermission(PERMISSIONS.CALENDAR_EVENT_MANAGE)),
  );
  routes.use("/api/school-events/:eventId", requirePermission(PERMISSIONS.CALENDAR_EVENT_MANAGE));

  routes.use("/api/school-events", onlyMethods(["POST"], auditAction("insert", "school_events")));
  routes.use(
    "/api/school-events/:eventId",
    onlyMethods(["PATCH"], auditAction("update", "school_events")),
  );
  routes.use(
    "/api/school-events/:eventId",
    onlyMethods(["DELETE"], auditAction("delete", "school_events")),
  );

  routes.openapi(listRoute, async (c) => {
    const auth = requireAuth(c);
    const { from, to } = c.req.valid("query");
    const items = await withTenantTx(database, tenantFrom(c), (tx) =>
      listSchoolEvents(tx, auth.schoolId, from, to),
    );
    return c.json({ items }, 200);
  });

  routes.openapi(createEventRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const event = await withTenantTx(database, tenantFrom(c), (tx) =>
      createSchoolEvent(tx, auth.schoolId, auth.userId, body),
    );
    return c.json(event, 201);
  });

  routes.openapi(updateEventRoute, async (c) => {
    const auth = requireAuth(c);
    const { eventId } = c.req.valid("param");
    const body = c.req.valid("json");
    const event = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateSchoolEvent(tx, auth.schoolId, eventId, body),
    );
    return c.json(event, 200);
  });

  routes.openapi(deleteEventRoute, async (c) => {
    const auth = requireAuth(c);
    const { eventId } = c.req.valid("param");
    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteSchoolEvent(tx, auth.schoolId, eventId),
    );
    return c.body(null, 204);
  });

  return routes;
}
