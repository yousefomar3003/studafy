import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction, emitAuditLog } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { getLocalizedMessage } from "../../../middleware/locale";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  getContentReport,
  listContentReports,
  reviewContentReport,
  type ContentReportDetailRow,
  type ContentReportRow,
} from "../moderation/persistence";
import {
  AI_CONTENT_TYPES,
  canTransitionReport,
  OPEN_REPORT_STATUSES,
  REPORT_PRIORITIES,
  REPORT_REASON_CATEGORIES,
  REPORT_STATUSES,
} from "../moderation/reports";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

/**
 * The AI content moderation queue (ST-306): `GET /api/ai/moderation/reports`,
 * `GET /api/ai/moderation/reports/{reportId}`, and `PATCH /api/ai/moderation/reports/{reportId}`.
 *
 * Holders of `aiContent:moderate` (ORG_ADMIN, SUPER_ADMIN -- see permissions.ts for why not
 * teachers) work the school's queue: student reports of AI output and the safety filter's
 * child-safety escalations. The list is ordered most urgent, then soonest due, and flags overdue
 * rows; it omits the reported text, which only the detail read returns -- and that read is itself
 * audit-logged, since the text may be harmful material. The review PATCH moves a report through
 * the workflow in `moderation/reports.ts`; every change is audit-logged in the same transaction.
 *
 * Tenant isolation is RLS (app.ai_content_reports is tenant-isolated), so a moderator only ever
 * sees their own school's queue. The procedure a moderator follows is the runbook:
 * docs/ai/content-moderation-runbook.md.
 */

const reportSummarySchema = z
  .object({
    id: z.string().uuid(),
    student_id: z.string().uuid(),
    content_type: z.enum(AI_CONTENT_TYPES),
    content_id: z.string().uuid().nullable(),
    source: z.enum(["user_report", "safety_filter"]),
    reporter_id: z.string().uuid().nullable(),
    reason_category: z.enum(REPORT_REASON_CATEGORIES),
    reason: z.string().nullable(),
    priority: z.enum(REPORT_PRIORITIES),
    respond_by: z.string().datetime(),
    overdue: z.boolean().openapi({
      description: "True when the report is still open past its `respond_by` deadline.",
    }),
    status: z.enum(REPORT_STATUSES),
    resolution_note: z.string().nullable(),
    reviewed_by: z.string().uuid().nullable(),
    reviewed_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
  })
  .openapi("AiContentReportSummary");

const reportDetailSchema = reportSummarySchema
  .extend({
    content_snapshot: z.string().openapi({
      description:
        "The reported AI output exactly as the server read it when the report was filed.",
    }),
  })
  .openapi("AiContentReport");

const reportIdParamSchema = z.object({
  reportId: z
    .string()
    .uuid()
    .openapi({ param: { name: "reportId", in: "path" }, description: "The report." }),
});

const listReportsRoute = createRoute({
  method: "get",
  path: "/api/ai/moderation/reports",
  tags: ["AI"],
  operationId: "listAiContentReports",
  summary: "List the AI content moderation queue",
  description:
    "The school's AI content reports, most urgent first, then soonest due. Defaults to open " +
    "reports (pending, in_review, escalated). Requires `aiContent:moderate`.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      status: z.enum(REPORT_STATUSES).optional().openapi({
        description: "Only this status. Omit for every open status.",
      }),
      priority: z.enum(REPORT_PRIORITIES).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: standardResponses(
    {
      200: {
        description: "One page of the queue.",
        schema: z.object({ reports: z.array(reportSummarySchema), total: z.number().int() }),
      },
    },
    [400, 401, 403, 422],
  ),
});

const getReportRoute = createRoute({
  method: "get",
  path: "/api/ai/moderation/reports/{reportId}",
  tags: ["AI"],
  operationId: "getAiContentReport",
  summary: "Read one AI content report, including the reported content",
  description:
    "Returns the report with its content snapshot. The read is audit-logged. Requires " +
    "`aiContent:moderate`.",
  security: [{ bearerAuth: [] }],
  request: { params: reportIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The report.", schema: reportDetailSchema } },
    [401, 403, 404],
  ),
});

const reviewReportRoute = createRoute({
  method: "patch",
  path: "/api/ai/moderation/reports/{reportId}",
  tags: ["AI"],
  operationId: "reviewAiContentReport",
  summary: "Move an AI content report through the review workflow",
  description:
    "pending -> in_review -> escalated | actioned | dismissed; escalated -> actioned | dismissed. " +
    "Every status except in_review requires a resolution_note (what was done, or where it was " +
    "escalated and the external reference). A disallowed change, or a report another moderator " +
    "changed first, is 409 AI_REPORT_INVALID_TRANSITION. Requires `aiContent:moderate`.",
  security: [{ bearerAuth: [] }],
  request: {
    params: reportIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              status: z.enum(REPORT_STATUSES),
              resolution_note: z.string().trim().min(1).max(2000).optional(),
            })
            .refine((body) => body.status === "in_review" || body.resolution_note !== undefined, {
              message: "resolution_note is required for this status",
              path: ["resolution_note"],
            }),
        },
      },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated report.", schema: reportDetailSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

function toSummary(row: ContentReportRow, now: Date) {
  return {
    id: row.id,
    student_id: row.student_id,
    content_type: row.content_type,
    content_id: row.content_id,
    source: row.source,
    reporter_id: row.reporter_id,
    reason_category: row.reason_category,
    reason: row.reason,
    priority: row.priority,
    respond_by: row.respond_by.toISOString(),
    overdue: OPEN_REPORT_STATUSES.includes(row.status) && row.respond_by < now,
    status: row.status,
    resolution_note: row.resolution_note,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

function toDetail(row: ContentReportDetailRow, now: Date) {
  return { ...toSummary(row, now), content_snapshot: row.content_snapshot };
}

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function localeOf(c: Context<AppEnv>): SupportedLocale {
  return (c.get("locale") ?? "en") as SupportedLocale;
}

function reportNotFound(locale: SupportedLocale): CodedHttpException {
  return new CodedHttpException(
    404,
    ERROR_CODES.AI_REPORT_NOT_FOUND,
    getLocalizedMessage(ERROR_CODES.AI_REPORT_NOT_FOUND, locale),
  );
}

export function aiModerationRoutes(deps: { database: Database }): OpenAPIHono<AppEnv> {
  const { database } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/ai/moderation/reports", requirePermission(PERMISSIONS.AI_CONTENT_MODERATE));
  routes.use(
    "/api/ai/moderation/reports/:reportId",
    requirePermission(PERMISSIONS.AI_CONTENT_MODERATE),
  );
  routes.use("/api/ai/moderation/reports/:reportId", auditAction("update", "ai_content_reports"));

  routes.openapi(listReportsRoute, async (c) => {
    const query = c.req.valid("query");
    const page = await withTenantTx(database, tenantFrom(c), (tx) =>
      listContentReports(tx, {
        statuses: query.status ? [query.status] : OPEN_REPORT_STATUSES,
        priority: query.priority ?? null,
        limit: query.limit,
        offset: query.offset,
      }),
    );
    const now = new Date();
    return c.json({ reports: page.rows.map((row) => toSummary(row, now)), total: page.total }, 200);
  });

  routes.openapi(getReportRoute, async (c) => {
    const { reportId } = c.req.valid("param");
    const report = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const row = await getContentReport(tx, reportId);
      if (row) {
        await emitAuditLog(tx, {
          action: "read",
          targetTable: "ai_content_reports",
          targetId: row.id,
        });
      }
      return row;
    });
    if (!report) throw reportNotFound(localeOf(c));
    return c.json(toDetail(report, new Date()), 200);
  });

  routes.openapi(reviewReportRoute, async (c) => {
    const auth = requireAuth(c);
    const locale = localeOf(c);
    const { reportId } = c.req.valid("param");
    const body = c.req.valid("json");

    const updated = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const current = await getContentReport(tx, reportId);
      if (!current) throw reportNotFound(locale);

      const invalid = new CodedHttpException(
        409,
        ERROR_CODES.AI_REPORT_INVALID_TRANSITION,
        getLocalizedMessage(ERROR_CODES.AI_REPORT_INVALID_TRANSITION, locale),
      );
      if (!canTransitionReport(current.status, body.status)) throw invalid;

      const row = await reviewContentReport(tx, {
        reportId,
        fromStatus: current.status,
        toStatus: body.status,
        reviewerId: auth.userId,
        resolutionNote: body.resolution_note ?? null,
      });
      // Another moderator moved it between the read and the write.
      if (!row) throw invalid;
      return row;
    });

    return c.json(toDetail(updated, new Date()), 200);
  });

  return routes;
}
