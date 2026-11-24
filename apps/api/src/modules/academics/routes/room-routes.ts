import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { createRoom, listRooms, updateRoom } from "../room-service";
import {
  roomCreateBodySchema,
  roomIdParamSchema,
  roomListSchema,
  roomQuerySchema,
  roomSchema,
  roomUpdateBodySchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRoomsRoute = createRoute({
  method: "get",
  path: "/api/academics/rooms",
  tags: ["Academics"],
  operationId: "listRooms",
  summary: "List rooms",
  description:
    "Paginated list of rooms for the authenticated school, ordered by code ascending. " +
    "Leadership adds and edits physical rooms (POST/PATCH); virtual rooms are provisioned " +
    "during school setup.",
  security: [{ bearerAuth: [] }],
  request: { query: roomQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of rooms.",
        schema: roomListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const createRoomRoute = createRoute({
  method: "post",
  path: "/api/academics/rooms",
  tags: ["Academics"],
  operationId: "createRoom",
  summary: "Add a room",
  description:
    "A physical room, with its everyday and exam capacity (seats in an exam, spaced). " +
    "timetable:manage. 409 CONFLICT_DUPLICATE_ENTRY when the code is already used.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: roomCreateBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The new room.", schema: roomSchema } },
    [400, 401, 403, 409, 500],
  ),
});

const updateRoomRoute = createRoute({
  method: "patch",
  path: "/api/academics/rooms/{roomId}",
  tags: ["Academics"],
  operationId: "updateRoom",
  summary: "Edit a room",
  description:
    "Name, building, floor, capacities, or deactivate it (rooms are never deleted: timetable " +
    "slots and exam seats keep pointing at them). timetable:manage.",
  security: [{ bearerAuth: [] }],
  request: {
    params: roomIdParamSchema,
    body: { required: true, content: { "application/json": { schema: roomUpdateBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The room.", schema: roomSchema } },
    [400, 401, 403, 404, 500],
  ),
});

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
// Route factory
// ---------------------------------------------------------------------------

export function roomRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.TIMETABLE_MANAGE);

  routes.use("/api/academics/rooms", onlyMethods(["POST"], manage));
  routes.use("/api/academics/rooms", auditAction("insert", "rooms"));
  routes.on("PATCH", "/api/academics/rooms/:roomId", manage, auditAction("update", "rooms"));

  routes.openapi(listRoomsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listRooms(tx, auth.schoolId, query),
    );

    return c.json({ rooms: rows, total }, 200);
  });

  routes.openapi(createRoomRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const room = await withTenantTx(database, tenantFrom(c), (tx) =>
      createRoom(tx, auth.schoolId, body),
    );
    return c.json(room, 201);
  });

  routes.openapi(updateRoomRoute, async (c) => {
    const auth = requireAuth(c);
    const { roomId } = c.req.valid("param");
    const body = c.req.valid("json");
    const room = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateRoom(tx, auth.schoolId, roomId, body),
    );
    return c.json(room, 200);
  });

  return routes;
}
