import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  getAttendanceSession,
  listAttendanceSessions,
  openAttendanceSession,
  updateAttendanceSessionStatus,
} from "../attendance-session-service";
import {
  attendanceSessionListSchema,
  attendanceSessionQuerySchema,
  attendanceSessionSchema,
  createAttendanceSessionBodySchema,
  sessionIdParamSchema,
  updateAttendanceSessionBodySchema,
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

const openSessionRoute = createRoute({
  method: "post",
  path: "/api/attendance/sessions",
  tags: ["Attendance"],
  operationId: "openAttendanceSession",
  summary: "Open an attendance session",
  description:
    "Opens an attendance session for a class on a given date and period. " +
    "Idempotent: if a session already exists for the same class, date, and period, " +
    "the existing session is returned.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createAttendanceSessionBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "A new attendance session was created.",
        schema: attendanceSessionSchema,
      },
      200: {
        description: "An existing session already covers this class, date, and period.",
        schema: attendanceSessionSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/api/attendance/sessions",
  tags: ["Attendance"],
  operationId: "listAttendanceSessions",
  summary: "List attendance sessions",
  description: "Paginated list of attendance sessions, ordered by date descending.",
  security: [{ bearerAuth: [] }],
  request: { query: attendanceSessionQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of attendance sessions.",
        schema: attendanceSessionListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const getSessionRoute = createRoute({
  method: "get",
  path: "/api/attendance/sessions/{sessionId}",
  tags: ["Attendance"],
  operationId: "getAttendanceSession",
  summary: "Get an attendance session",
  description: "Returns a single attendance session by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: sessionIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The attendance session.",
        schema: attendanceSessionSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateSessionStatusRoute = createRoute({
  method: "patch",
  path: "/api/attendance/sessions/{sessionId}",
  tags: ["Attendance"],
  operationId: "updateAttendanceSessionStatus",
  summary: "Update attendance session status",
  description:
    "Transitions an attendance session to a new status. Valid transitions: " +
    "draft → open | cancelled, open → submitted | cancelled, submitted → locked.",
  security: [{ bearerAuth: [] }],
  request: {
    params: sessionIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateAttendanceSessionBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated attendance session.",
        schema: attendanceSessionSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function attendanceSessionRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/attendance/sessions", auditAction("insert", "attendance_sessions"));
  routes.use("/api/attendance/sessions/{sessionId}", auditAction("update", "attendance_sessions"));

  // --- Open session (idempotent) ---

  routes.openapi(openSessionRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const { session, created } = await withTenantTx(database, tenantFrom(c), (tx) =>
      openAttendanceSession(tx, auth.schoolId, auth.userId, {
        class_id: body.class_id,
        session_date: body.session_date,
        period: body.period,
      }),
    );

    return c.json(session, created ? 201 : 200);
  });

  // --- List sessions ---

  routes.openapi(listSessionsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listAttendanceSessions(tx, auth.schoolId, query),
    );

    return c.json({ attendance_sessions: rows, total }, 200);
  });

  // --- Get session ---

  routes.openapi(getSessionRoute, async (c) => {
    const auth = requireAuth(c);
    const { sessionId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getAttendanceSession(tx, auth.schoolId, sessionId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Attendance session not found" });
    }

    return c.json(row, 200);
  });

  // --- Update status ---

  routes.openapi(updateSessionStatusRoute, async (c) => {
    const auth = requireAuth(c);
    const { sessionId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateAttendanceSessionStatus(tx, auth.schoolId, sessionId, body),
    );

    return c.json(row, 200);
  });

  return routes;
}
