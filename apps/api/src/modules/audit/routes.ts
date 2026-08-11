import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  AuditLogFilterError,
  queryAuditLogPage,
  resolveAuditLogFilter,
} from "@studafy/audit-reporting";
import { ERROR_CODES, JOB_NAMES, PERMISSIONS, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { CodedHttpException } from "../../coded-http-exception";
import { withTenantTx } from "../../db/tenant-tx";
import { requireStorage } from "../../lib/storage";
import { auditAction, emitAuditLog } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import {
  auditExportBodySchema,
  auditExportJobIdParamSchema,
  auditExportJobSchema,
  auditLogPageResponseSchema,
  auditLogQuerySchema,
} from "./schemas";
import { createAuditExportJob, failAuditExportJob, getAuditExportJob } from "./service";

import type { AuditExportJobRow } from "./service";
import type { Database } from "../../db/client";
import type { StorageService } from "../../lib/storage";
import type { AppEnv } from "../../middleware/requestId";
import type { RedisClient } from "../../redis";
import type {
  AuditExportJobData,
  AuditLogFilterInput,
  ResolvedAuditLogFilter,
} from "@studafy/audit-reporting";
import type { Context } from "hono";

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function clientIpFrom(c: Context<AppEnv>): string | null {
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded === undefined) return null;
  const first = forwarded.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

function filterFrom(value: {
  from?: string;
  to?: string;
  actor_id?: string;
  action?: string;
  target_table?: string;
  target_id?: string;
}): AuditLogFilterInput {
  return {
    ...(value.from ? { from: value.from } : {}),
    ...(value.to ? { to: value.to } : {}),
    ...(value.actor_id ? { actorId: value.actor_id } : {}),
    ...(value.action ? { action: value.action } : {}),
    ...(value.target_table ? { targetTable: value.target_table } : {}),
    ...(value.target_id ? { targetId: value.target_id } : {}),
  };
}

function filterResponse(resolved: ResolvedAuditLogFilter) {
  return {
    from: resolved.from,
    to: resolved.to,
    ...(resolved.actorId ? { actor_id: resolved.actorId } : {}),
    ...(resolved.action ? { action: resolved.action } : {}),
    ...(resolved.targetTable ? { target_table: resolved.targetTable } : {}),
    ...(resolved.targetId ? { target_id: resolved.targetId } : {}),
  };
}

function translateAuditError(error: unknown): never {
  if (error instanceof AuditLogFilterError) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, error.message);
  }
  throw error;
}

function toJobResponse(
  job: AuditExportJobRow,
  presigned: { url: string; expiresAt: Date } | null = null,
) {
  return {
    id: job.id,
    file_format: job.file_format,
    status: job.status,
    created_at: job.created_at.toISOString(),
    completed_at: job.completed_at?.toISOString() ?? null,
    download_url: presigned?.url ?? null,
    download_url_expires_at: presigned?.expiresAt.toISOString() ?? null,
    failure_message: job.failure_message,
  };
}

const listLogsRoute = createRoute({
  method: "get",
  path: "/api/audit/logs",
  tags: ["Audit Logs"],
  operationId: "listAuditLogs",
  summary: "Page through the school's audit log",
  security: [{ bearerAuth: [] }],
  request: { query: auditLogQuerySchema },
  responses: standardResponses(
    { 200: { description: "A page of audit-log entries.", schema: auditLogPageResponseSchema } },
    [400, 401, 403, 500],
  ),
});

const createExportRoute = createRoute({
  method: "post",
  path: "/api/audit/logs/export",
  tags: ["Audit Logs"],
  operationId: "createAuditLogExport",
  summary: "Queue a CSV export of the audit log",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: auditExportBodySchema } },
    },
  },
  responses: standardResponses(
    { 202: { description: "Export accepted.", schema: auditExportJobSchema } },
    [400, 401, 403, 503, 500],
  ),
});

const getExportRoute = createRoute({
  method: "get",
  path: "/api/audit/logs/export/{jobId}",
  tags: ["Audit Logs"],
  operationId: "getAuditLogExport",
  summary: "Get audit export status",
  security: [{ bearerAuth: [] }],
  request: { params: auditExportJobIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Export status and optional download URL.",
        schema: auditExportJobSchema,
      },
    },
    [401, 403, 404, 503, 500],
  ),
});

export function auditRoutes(
  primary: Database,
  redis: RedisClient | null,
  storage: StorageService | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const reportsQueue = redis
    ? new Queue(QUEUE_NAMES.REPORTS, { connection: redis as never })
    : null;

  routes.use("/api/audit/logs", requirePermission(PERMISSIONS.AUDIT_LOG_READ));
  routes.use("/api/audit/logs/export", requirePermission(PERMISSIONS.AUDIT_LOG_EXPORT));
  routes.use("/api/audit/logs/export", auditAction("insert", "audit_export_jobs"));
  routes.use("/api/audit/logs/export/{jobId}", requirePermission(PERMISSIONS.AUDIT_LOG_EXPORT));

  routes.openapi(listLogsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");
    try {
      const result = await withTenantTx(primary, tenantFrom(c), async (tx) => {
        const resolved = resolveAuditLogFilter(filterFrom(query));
        const page = await queryAuditLogPage(tx, auth.schoolId, resolved, {
          limit: query.limit,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        });
        await emitAuditLog(tx, {
          action: "read",
          targetTable: "audit_logs",
          targetId: auth.schoolId,
          newValues: { ...resolved, limit: query.limit, cursor: query.cursor ?? null },
          clientIp: clientIpFrom(c),
          userAgent: c.req.header("user-agent"),
        });
        return { resolved, page };
      });
      return c.json(
        {
          generated_at: new Date().toISOString(),
          filter: filterResponse(result.resolved),
          limit: query.limit,
          items: result.page.items,
          next_cursor: result.page.nextCursor,
          has_more: result.page.hasMore,
        },
        200,
      );
    } catch (error) {
      return translateAuditError(error);
    }
  });

  routes.openapi(createExportRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    if (!reportsQueue) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.AUDIT_LOG_EXPORT_UNAVAILABLE,
        "Report queue is not configured for this deployment",
      );
    }
    requireStorage(storage);

    let resolved: ResolvedAuditLogFilter;
    try {
      resolved = resolveAuditLogFilter(filterFrom(body));
    } catch (error) {
      return translateAuditError(error);
    }

    const job = await withTenantTx(primary, tenantFrom(c), (tx) =>
      createAuditExportJob(tx, auth.schoolId, auth.userId, resolved),
    );
    const payload: AuditExportJobData = {
      version: 1,
      jobId: job.id,
      schoolId: auth.schoolId,
      requestedByUserId: auth.userId,
    };

    try {
      await reportsQueue.add(JOB_NAMES.GENERATE_AUDIT_EXPORT, payload, {
        jobId: job.id,
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      });
    } catch {
      await withTenantTx(primary, tenantFrom(c), (tx) =>
        failAuditExportJob(tx, auth.schoolId, job.id, "Failed to enqueue export"),
      );
      throw new CodedHttpException(
        503,
        ERROR_CODES.AUDIT_LOG_EXPORT_UNAVAILABLE,
        "Audit export could not be queued",
      );
    }

    return c.json(toJobResponse(job), 202);
  });

  routes.openapi(getExportRoute, async (c) => {
    const auth = requireAuth(c);
    const { jobId } = c.req.valid("param");
    const job = await withTenantTx(primary, tenantFrom(c), (tx) =>
      getAuditExportJob(tx, auth.schoolId, auth.userId, jobId),
    );
    if (!job) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.AUDIT_LOG_EXPORT_NOT_FOUND,
        "Audit export job not found",
      );
    }
    const presigned =
      job.status === "completed" && job.storage_key
        ? await requireStorage(storage).presign(job.storage_key, "GET", undefined, 15 * 60)
        : null;
    return c.json(toJobResponse(job, presigned), 200);
  });

  return routes;
}
