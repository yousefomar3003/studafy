import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { withTenantTx } from "../../../../db/tenant-tx";
import { auditAction } from "../../../../middleware/auditEmitter";
import { requireAuth } from "../../../../middleware/authContext";
import { hasPermission, requirePermission } from "../../../../middleware/authz";
import { openApiValidationHook } from "../../../../openapi/hook";
import { standardResponses } from "../../../../openapi/responses";
import { enqueueAttendanceAlerts } from "../../enqueue-alerts";
import { correctAttendanceRecord, getAttendanceRecordHistory } from "../correction-service";
import {
  attendanceRecordHistorySchema,
  correctAttendanceRecordBodySchema,
  correctedAttendanceRecordSchema,
  recordIdParamSchema,
} from "../schemas";

import type { Database } from "../../../../db/client";
import type { AppEnv } from "../../../../middleware/requestId";
import type { RedisClient } from "../../../../redis";
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

const correctRecordRoute = createRoute({
  method: "patch",
  path: "/api/attendance/records/{recordId}",
  tags: ["Attendance"],
  operationId: "correctAttendanceRecord",
  summary: "Correct an attendance record",
  description:
    "Amends a previously submitted attendance record, preserving the prior state in an immutable " +
    "version chain. Requires a non-empty reason. Applies only once the parent session has been " +
    "submitted or locked; while it is still open, use POST /api/attendance/records/batch. " +
    "Within the school's correction window an assigned teacher or a principal may correct. Past " +
    "it a teacher is refused with ATTENDANCE_CORRECTION_WINDOW_EXPIRED, and a principal's " +
    "correction is flagged as an out-of-window administrative override.",
  security: [{ bearerAuth: [] }],
  request: {
    params: recordIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: correctAttendanceRecordBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The corrected attendance record, at its new version.",
        schema: correctedAttendanceRecordSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const recordHistoryRoute = createRoute({
  method: "get",
  path: "/api/attendance/records/{recordId}/history",
  tags: ["Attendance"],
  operationId: "getAttendanceRecordHistory",
  summary: "Get an attendance record's correction history",
  description:
    "Returns the full correction chain for a record in ascending version order: the initial " +
    "submission as version 1, followed by every subsequent status shift with its acting user, " +
    "timestamp, and justification.",
  security: [{ bearerAuth: [] }],
  request: { params: recordIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The correction chain, oldest generation first.",
        schema: attendanceRecordHistorySchema,
      },
    },
    [400, 401, 403, 404, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function attendanceCorrectionRoutes(
  database: Database,
  redis: RedisClient | null = null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const notificationsQueue = redis
    ? new Queue(QUEUE_NAMES.NOTIFICATIONS, { connection: redis as never })
    : null;

  // Audit declarations
  routes.use("/api/attendance/records/{recordId}", auditAction("update", "attendance_records"));

  // Permission guards
  routes.use(
    "/api/attendance/records/{recordId}",
    requirePermission(PERMISSIONS.ATTENDANCE_RECORD_CORRECT),
  );
  routes.use(
    "/api/attendance/records/{recordId}/history",
    requirePermission(PERMISSIONS.ATTENDANCE_RECORD_READ),
  );

  // --- Correct a record ---

  routes.openapi(correctRecordRoute, async (c) => {
    const auth = requireAuth(c);
    const { recordId } = c.req.valid("param");
    const body = c.req.valid("json");

    // Resolved here rather than in the service so the permission matrix stays the only place that
    // knows which roles carry an override, and the service stays a pure function of its inputs.
    const canOverride = hasPermission(auth.roles, PERMISSIONS.ATTENDANCE_CORRECTION_OVERRIDE);

    const record = await withTenantTx(database, tenantFrom(c), (tx) =>
      correctAttendanceRecord(tx, auth.schoolId, auth.userId, canOverride, recordId, {
        status: body.status,
        minutes_late: body.minutes_late,
        reason: body.reason,
      }),
    );

    // ST-110: a correction INTO 'absent' can complete a threshold run that nothing else would
    // ever notice — the batch path only sees the day it was submitted. Correcting away from
    // 'absent' enqueues nothing: alerts already sent stay sent, and the log is immutable.
    if (record.status === "absent") {
      await enqueueAttendanceAlerts(notificationsQueue, c, {
        schoolId: auth.schoolId,
        attendanceSessionId: record.attendance_session_id,
        sessionDate: record.session_date,
        studentIds: [record.student_id],
      });
    }

    return c.json(
      {
        ...record,
        created_at: record.created_at.toISOString(),
        updated_at: record.updated_at.toISOString(),
      },
      200,
    );
  });

  // --- Correction history ---

  routes.openapi(recordHistoryRoute, async (c) => {
    const auth = requireAuth(c);
    const { recordId } = c.req.valid("param");

    const history = await withTenantTx(database, tenantFrom(c), (tx) =>
      getAttendanceRecordHistory(tx, auth.schoolId, recordId),
    );

    return c.json(
      {
        ...history,
        entries: history.entries.map((entry) => ({
          ...entry,
          corrected_at: entry.corrected_at.toISOString(),
        })),
      },
      200,
    );
  });

  return routes;
}
