import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { withTenantTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { listRooms } from "../room-service";
import { roomListSchema, roomQuerySchema } from "../schemas";

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
    "Read-only: rooms are provisioned during school setup.",
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

  routes.openapi(listRoomsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listRooms(tx, auth.schoolId, query),
    );

    return c.json({ rooms: rows, total }, 200);
  });

  return routes;
}
