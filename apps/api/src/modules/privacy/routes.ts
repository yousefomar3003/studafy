/**
 * Data subject request tooling (ST-268, extended for account-deletion self-service): two ways to
 * file a GDPR export or erasure request.
 *
 * - `/api/privacy/dsr[/{requestId}]`: an ORG_ADMIN/SUPER_ADMIN files a request on a subject's
 *   behalf and reads its status back. `PRIVACY_DSR_MANAGE`-gated.
 * - `/api/privacy/me/dsr`: any authenticated user files a request about their own account and
 *   lists their own request history. No permission gate beyond authentication -- the subject is
 *   always the caller, never a body parameter, so there is nothing a permission check would add.
 *
 * Filing inserts the row and enqueues the job onto the maintenance queue in one step, mirroring
 * the audit export route's create-then-enqueue shape (apps/api/src/modules/audit/routes.ts) --
 * including its "roll the row back to failed if the enqueue itself throws" fallback
 * ([enqueueDsrJob]), so a Redis blip never leaves a request stuck `queued` with nothing actually
 * going to process it. Both routes share that helper; only how the subject is determined differs.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, JOB_NAMES, PERMISSIONS, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { CodedHttpException } from "../../coded-http-exception";
import { withTenantTx } from "../../db/tenant-tx";
import { requireStorage } from "../../lib/storage";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import {
  createDsrBodySchema,
  createSelfDsrBodySchema,
  dsrIdParamSchema,
  dsrListResponseSchema,
  dsrResponseSchema,
} from "./schemas";
import {
  createDsrRequest,
  findOpenDsrRequest,
  getDsrRequest,
  listDsrRequestsForSubject,
  subjectExists,
} from "./service";

import type { DataSubjectRequestRow } from "./service";
import type { Database } from "../../db/client";
import type { StorageService } from "../../lib/storage";
import type { AppEnv } from "../../middleware/requestId";
import type { RedisClient } from "../../redis";
import type { Context } from "hono";

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId };
}

/**
 * Enqueues the export/erasure job for an already-created row, rolling the row back to `failed`
 * if the enqueue itself throws -- shared by the admin-filed and self-filed create routes so the
 * "queued but nothing will ever process it" failure mode has exactly one fix, not two copies that
 * can drift.
 */
async function enqueueDsrJob(
  maintenanceQueue: Queue,
  primary: Database,
  tenant: { schoolId: string; userId: string },
  row: DataSubjectRequestRow,
): Promise<void> {
  const jobName =
    row.requestType === "export"
      ? JOB_NAMES.RUN_DATA_SUBJECT_EXPORT
      : JOB_NAMES.RUN_DATA_SUBJECT_ERASURE;
  try {
    await maintenanceQueue.add(
      jobName,
      { requestId: row.id, schoolId: tenant.schoolId },
      {
        jobId: row.id,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 30 * 24 * 60 * 60 },
        removeOnFail: { age: 30 * 24 * 60 * 60 },
      },
    );
  } catch {
    // Best-effort: mark the row failed so it does not sit `queued` forever with nothing to
    // process it. The maintenance queue's own claim/fail lifecycle owns every other failure path;
    // this one exists only because the enqueue call itself is what just threw.
    await withTenantTx(
      primary,
      tenant,
      (tx) =>
        tx`
        UPDATE app.data_subject_requests
        SET status = 'failed', failure_message = 'Failed to enqueue request', completed_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND school_id = ${tenant.schoolId}::uuid AND status = 'queued'
      `,
    );
    throw new CodedHttpException(
      503,
      ERROR_CODES.DSR_UNAVAILABLE,
      "The data subject request could not be queued",
    );
  }
}

function toResponse(
  row: DataSubjectRequestRow,
  presigned: { url: string; expiresAt: Date } | null = null,
) {
  return {
    id: row.id,
    request_type: row.requestType,
    subject_user_id: row.subjectUserId,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
    sla_due_at: row.slaDueAt.toISOString(),
    download_url: presigned?.url ?? null,
    download_url_expires_at: presigned?.expiresAt.toISOString() ?? null,
    failure_message: row.failureMessage,
  };
}

const createDsrRoute = createRoute({
  method: "post",
  path: "/api/privacy/dsr",
  tags: ["Privacy"],
  operationId: "createDataSubjectRequest",
  summary: "File a GDPR export or erasure request for one user",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: createDsrBodySchema } } },
  },
  responses: standardResponses(
    { 202: { description: "Request accepted.", schema: dsrResponseSchema } },
    [400, 401, 403, 404, 409, 503, 500],
  ),
});

const getDsrRoute = createRoute({
  method: "get",
  path: "/api/privacy/dsr/{requestId}",
  tags: ["Privacy"],
  operationId: "getDataSubjectRequest",
  summary: "Get a data subject request's status",
  security: [{ bearerAuth: [] }],
  request: { params: dsrIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Request status and, for a completed export, a download URL.",
        schema: dsrResponseSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

// Self-service (no PRIVACY_DSR_MANAGE) -- a caller filing an export or erasure request about their
// own account. Deliberately under /api/privacy/me/, not /api/privacy/dsr/{requestId}, so its route
// pattern can never collide with the admin-managed `{requestId}` path above.
const createSelfDsrRoute = createRoute({
  method: "post",
  path: "/api/privacy/me/dsr",
  tags: ["Privacy"],
  operationId: "createSelfDataSubjectRequest",
  summary: "File a GDPR export or erasure request for the caller's own account",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: createSelfDsrBodySchema } } },
  },
  responses: standardResponses(
    { 202: { description: "Request accepted.", schema: dsrResponseSchema } },
    [400, 401, 409, 503, 500],
  ),
});

const listSelfDsrRoute = createRoute({
  method: "get",
  path: "/api/privacy/me/dsr",
  tags: ["Privacy"],
  operationId: "listSelfDataSubjectRequests",
  summary: "List the caller's own GDPR export/erasure requests, most recent first",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The caller's own requests.", schema: dsrListResponseSchema } },
    [401, 500],
  ),
});

export function privacyRoutes(
  primary: Database,
  redis: RedisClient | null,
  storage: StorageService | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const maintenanceQueue = redis
    ? new Queue(QUEUE_NAMES.MAINTENANCE, { connection: redis as never })
    : null;

  routes.use("/api/privacy/dsr", requirePermission(PERMISSIONS.PRIVACY_DSR_MANAGE));
  routes.use("/api/privacy/dsr", auditAction("insert", "data_subject_requests"));
  routes.use("/api/privacy/dsr/:requestId", requirePermission(PERMISSIONS.PRIVACY_DSR_MANAGE));
  // Self-service: bearer-authenticated only, deliberately no requirePermission -- the caller may
  // only ever act on their own subject_user_id, enforced in the handlers below, not by a
  // permission grant. (routes.use() applies to every method on this path; the GET handler simply
  // never calls emitAuditLog, so this declaration is inert for it.)
  routes.use("/api/privacy/me/dsr", auditAction("insert", "data_subject_requests"));

  routes.openapi(createDsrRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    if (!maintenanceQueue) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.DSR_UNAVAILABLE,
        "The data subject request queue is not configured for this deployment",
      );
    }
    requireStorage(storage);

    const row = await withTenantTx(primary, tenantFrom(c), async (tx) => {
      if (!(await subjectExists(tx, auth.schoolId, body.subject_user_id))) {
        throw new CodedHttpException(
          404,
          ERROR_CODES.DSR_SUBJECT_NOT_FOUND,
          "This user does not belong to your school",
        );
      }
      const open = await findOpenDsrRequest(
        tx,
        auth.schoolId,
        body.subject_user_id,
        body.request_type,
      );
      if (open) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.DSR_ALREADY_PENDING,
          "A request of this type is already queued or processing for this user",
        );
      }
      return createDsrRequest(
        tx,
        auth.schoolId,
        auth.userId,
        body.subject_user_id,
        body.request_type,
      );
    });

    await enqueueDsrJob(maintenanceQueue, primary, tenantFrom(c), row);
    return c.json(toResponse(row), 202);
  });

  routes.openapi(createSelfDsrRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    if (!maintenanceQueue) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.DSR_UNAVAILABLE,
        "The data subject request queue is not configured for this deployment",
      );
    }
    requireStorage(storage);

    const row = await withTenantTx(primary, tenantFrom(c), async (tx) => {
      const open = await findOpenDsrRequest(tx, auth.schoolId, auth.userId, body.request_type);
      if (open) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.DSR_ALREADY_PENDING,
          "A request of this type is already queued or processing for your account",
        );
      }
      return createDsrRequest(tx, auth.schoolId, auth.userId, auth.userId, body.request_type);
    });

    await enqueueDsrJob(maintenanceQueue, primary, tenantFrom(c), row);
    return c.json(toResponse(row), 202);
  });

  routes.openapi(listSelfDsrRoute, async (c) => {
    const auth = requireAuth(c);
    const rows = await withTenantTx(primary, tenantFrom(c), (tx) =>
      listDsrRequestsForSubject(tx, auth.schoolId, auth.userId),
    );
    return c.json(
      rows.map((row) => toResponse(row)),
      200,
    );
  });

  routes.openapi(getDsrRoute, async (c) => {
    const auth = requireAuth(c);
    const { requestId } = c.req.valid("param");
    const row = await withTenantTx(primary, tenantFrom(c), (tx) =>
      getDsrRequest(tx, auth.schoolId, requestId),
    );
    if (!row) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.DSR_NOT_FOUND,
        "Data subject request not found",
      );
    }
    const presigned =
      row.status === "completed" && row.storageKey
        ? await requireStorage(storage).presign(row.storageKey, "GET", undefined, 15 * 60)
        : null;
    return c.json(toResponse(row, presigned), 200);
  });

  return routes;
}
