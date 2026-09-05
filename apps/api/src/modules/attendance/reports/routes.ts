import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ReportFilterError,
  ReportResourceNotFoundError,
  queryAttendanceSummary,
  queryAttendanceTrends,
  resolveReportFilter,
} from "@studafy/attendance-reporting";
import { ERROR_CODES, JOB_NAMES, PERMISSIONS, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { requireStorage } from "../../../lib/storage";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import { createReportExportJob, failReportExportJob, getReportExportJob } from "./report-service";
import {
  attendanceExportBodySchema,
  attendanceSummaryQuerySchema,
  attendanceSummaryResponseSchema,
  attendanceTrendsQuerySchema,
  attendanceTrendsResponseSchema,
  exportJobIdParamSchema,
  reportExportJobSchema,
} from "./schemas";

import type { Database, DatabasePools } from "../../../db/client";
import type { StorageService } from "../../../lib/storage";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type {
  AttendanceExportJobData,
  ReportFilterInput,
  ResolvedReportFilter,
} from "@studafy/attendance-reporting";
import type { Context } from "hono";

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function filterFrom(value: {
  term_id?: string;
  start_date?: string;
  end_date?: string;
  class_id?: string;
  student_id?: string;
}): ReportFilterInput {
  return {
    ...(value.term_id ? { termId: value.term_id } : {}),
    ...(value.start_date ? { startDate: value.start_date } : {}),
    ...(value.end_date ? { endDate: value.end_date } : {}),
    ...(value.class_id ? { classId: value.class_id } : {}),
    ...(value.student_id ? { studentId: value.student_id } : {}),
  };
}

function period(filter: ResolvedReportFilter) {
  return {
    term_id: filter.termId,
    start_date: filter.startDate,
    end_date: filter.endDate,
  };
}

function translateReportError(error: unknown): never {
  if (error instanceof ReportResourceNotFoundError) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.ATTENDANCE_REPORT_RESOURCE_NOT_FOUND,
      error.message,
    );
  }
  if (error instanceof ReportFilterError) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, error.message);
  }
  throw error;
}

const summaryRoute = createRoute({
  method: "get",
  path: "/api/attendance/reports/summary",
  tags: ["Attendance Reports"],
  operationId: "getAttendanceReportSummary",
  summary: "Get grouped attendance summary",
  security: [{ bearerAuth: [] }],
  request: { query: attendanceSummaryQuerySchema },
  responses: standardResponses(
    {
      200: { description: "Grouped attendance metrics.", schema: attendanceSummaryResponseSchema },
    },
    [400, 401, 403, 404, 500],
  ),
});

const trendsRoute = createRoute({
  method: "get",
  path: "/api/attendance/reports/trends",
  tags: ["Attendance Reports"],
  operationId: "getAttendanceReportTrends",
  summary: "Get attendance trend series",
  security: [{ bearerAuth: [] }],
  request: { query: attendanceTrendsQuerySchema },
  responses: standardResponses(
    { 200: { description: "Attendance trend points.", schema: attendanceTrendsResponseSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const createExportRoute = createRoute({
  method: "post",
  path: "/api/attendance/reports/export",
  tags: ["Attendance Reports"],
  operationId: "createAttendanceReportExport",
  summary: "Queue an attendance report export",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: attendanceExportBodySchema } },
    },
  },
  responses: standardResponses(
    { 202: { description: "Export accepted.", schema: reportExportJobSchema } },
    [400, 401, 403, 404, 503, 500],
  ),
});

const getExportRoute = createRoute({
  method: "get",
  path: "/api/attendance/reports/export/{jobId}",
  tags: ["Attendance Reports"],
  operationId: "getAttendanceReportExport",
  summary: "Get attendance export status",
  security: [{ bearerAuth: [] }],
  request: { params: exportJobIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Export status and optional download URL.",
        schema: reportExportJobSchema,
      },
    },
    [401, 403, 404, 503, 500],
  ),
});

export function attendanceReportRoutes(
  primary: Database,
  readReplica: Database,
  redis: RedisClient | null,
  storage: StorageService | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const databases: DatabasePools = { primary, readReplica };
  const reportsQueue = redis
    ? new Queue(QUEUE_NAMES.REPORTS, { connection: redis as never })
    : null;

  routes.use(
    "/api/attendance/reports/summary",
    requirePermission(PERMISSIONS.ATTENDANCE_REPORT_READ),
  );
  routes.use(
    "/api/attendance/reports/trends",
    requirePermission(PERMISSIONS.ATTENDANCE_REPORT_READ),
  );
  routes.use(
    "/api/attendance/reports/export",
    requirePermission(PERMISSIONS.ATTENDANCE_REPORT_EXPORT),
  );
  routes.use("/api/attendance/reports/export", auditAction("insert", "report_export_jobs"));
  routes.use(
    "/api/attendance/reports/export/:jobId",
    requirePermission(PERMISSIONS.ATTENDANCE_REPORT_EXPORT),
  );

  routes.openapi(summaryRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");
    try {
      const result = await withTenantTx(
        databases,
        tenantFrom(c),
        async (tx) => {
          const resolved = await resolveReportFilter(tx, auth.schoolId, filterFrom(query));
          const summary = await queryAttendanceSummary(
            tx,
            auth.schoolId,
            resolved,
            query.group_by,
            { limit: query.limit, offset: query.offset },
          );
          return { resolved, summary };
        },
        { useReadReplica: true },
      );
      return c.json(
        {
          generated_at: new Date().toISOString(),
          period: period(result.resolved),
          group_by: query.group_by,
          totals: result.summary.totals,
          items: result.summary.items,
          pagination: {
            limit: query.limit,
            offset: query.offset,
            total: result.summary.total_groups,
          },
        },
        200,
      );
    } catch (error) {
      return translateReportError(error);
    }
  });

  routes.openapi(trendsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");
    try {
      const result = await withTenantTx(
        databases,
        tenantFrom(c),
        async (tx) => {
          const resolved = await resolveReportFilter(tx, auth.schoolId, filterFrom(query));
          const points = await queryAttendanceTrends(tx, auth.schoolId, resolved, query.interval);
          return { resolved, points };
        },
        { useReadReplica: true },
      );
      return c.json(
        {
          generated_at: new Date().toISOString(),
          period: period(result.resolved),
          interval: query.interval,
          points: result.points,
        },
        200,
      );
    } catch (error) {
      return translateReportError(error);
    }
  });

  routes.openapi(createExportRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    if (!reportsQueue) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.ATTENDANCE_EXPORT_UNAVAILABLE,
        "Report queue is not configured for this deployment",
      );
    }
    requireStorage(storage);

    let resolved: ResolvedReportFilter;
    try {
      resolved = await withTenantTx(
        databases,
        tenantFrom(c),
        (tx) => resolveReportFilter(tx, auth.schoolId, filterFrom(body)),
        { useReadReplica: true },
      );
    } catch (error) {
      return translateReportError(error);
    }

    const job = await withTenantTx(primary, tenantFrom(c), (tx) =>
      createReportExportJob(tx, auth.schoolId, auth.userId, body.file_format),
    );
    const payload: AttendanceExportJobData = {
      version: 1,
      jobId: job.id,
      schoolId: auth.schoolId,
      requestedByUserId: auth.userId,
      filter: resolved,
      groupBy: body.group_by,
      trendInterval: body.trend_interval,
      fileFormat: body.file_format,
    };

    try {
      await reportsQueue.add(JOB_NAMES.GENERATE_ATTENDANCE_EXPORT, payload, {
        jobId: job.id,
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      });
    } catch {
      await withTenantTx(primary, tenantFrom(c), (tx) =>
        failReportExportJob(tx, auth.schoolId, job.id, "Failed to enqueue export"),
      );
      throw new CodedHttpException(
        503,
        ERROR_CODES.ATTENDANCE_EXPORT_UNAVAILABLE,
        "Report export could not be queued",
      );
    }

    return c.json(
      {
        id: job.id,
        report_type: job.report_type,
        file_format: job.file_format,
        status: job.status,
        created_at: job.created_at.toISOString(),
        completed_at: null,
        download_url: null,
        download_url_expires_at: null,
        failure_message: null,
      },
      202,
    );
  });

  routes.openapi(getExportRoute, async (c) => {
    const auth = requireAuth(c);
    const { jobId } = c.req.valid("param");
    const job = await withTenantTx(primary, tenantFrom(c), (tx) =>
      getReportExportJob(tx, auth.schoolId, auth.userId, jobId),
    );
    if (!job) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.ATTENDANCE_EXPORT_NOT_FOUND,
        "Attendance export job not found",
      );
    }
    const presigned =
      job.status === "completed" && job.storage_key
        ? await requireStorage(storage).presign(job.storage_key, "GET", undefined, 15 * 60)
        : null;
    return c.json(
      {
        id: job.id,
        report_type: job.report_type,
        file_format: job.file_format,
        status: job.status,
        created_at: job.created_at.toISOString(),
        completed_at: job.completed_at?.toISOString() ?? null,
        download_url: presigned?.url ?? null,
        download_url_expires_at: presigned?.expiresAt.toISOString() ?? null,
        failure_message: job.status === "failed" ? "Export generation failed" : null,
      },
      200,
    );
  });

  return routes;
}
