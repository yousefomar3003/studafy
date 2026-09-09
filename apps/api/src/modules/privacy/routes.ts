/**
 * Per-user data subject request tooling (ST-268): an ORG_ADMIN/SUPER_ADMIN files a GDPR export or
 * erasure request on a subject's behalf, and reads its status back. Filing inserts the row and
 * enqueues the job onto the maintenance queue in one step, mirroring the audit export route's
 * create-then-enqueue shape (apps/api/src/modules/audit/routes.ts) -- including its "roll the row
 * back to failed if the enqueue itself throws" fallback, so a Redis blip never leaves a request
 * stuck `queued` with nothing actually going to process it.
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

import { createDsrBodySchema, dsrIdParamSchema, dsrResponseSchema } from "./schemas";
import { createDsrRequest, findOpenDsrRequest, getDsrRequest, subjectExists } from "./service";

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

    const jobName =
      body.request_type === "export"
        ? JOB_NAMES.RUN_DATA_SUBJECT_EXPORT
        : JOB_NAMES.RUN_DATA_SUBJECT_ERASURE;
    try {
      await maintenanceQueue.add(
        jobName,
        { requestId: row.id, schoolId: auth.schoolId },
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
        tenantFrom(c),
        (tx) =>
          tx`
          UPDATE app.data_subject_requests
          SET status = 'failed', failure_message = 'Failed to enqueue request', completed_at = clock_timestamp()
          WHERE id = ${row.id}::uuid AND school_id = ${auth.schoolId}::uuid AND status = 'queued'
        `,
      );
      throw new CodedHttpException(
        503,
        ERROR_CODES.DSR_UNAVAILABLE,
        "The data subject request could not be queued",
      );
    }

    return c.json(toResponse(row), 202);
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
