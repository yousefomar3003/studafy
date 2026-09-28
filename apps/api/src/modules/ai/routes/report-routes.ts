import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AI_SUMMARY_LENGTHS, type AiSummaryLength } from "../config";
import { insertUserReport, isUniqueViolation } from "../moderation/persistence";
import {
  REPORT_PRIORITIES,
  REPORT_REASON_CATEGORIES,
  REPORTABLE_CONTENT_TYPES,
  reportPriority,
  reportRespondBy,
  type ReportableContentType,
  type ReportReasonCategory,
} from "../moderation/reports";
import { loadContentSnapshot } from "../moderation/snapshots";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { SummaryCache } from "../summary/cache";
import type { Context } from "hono";

/**
 * Reporting AI output (ST-172, generalized in ST-306).
 *
 * `POST /api/ai/students/{studentId}/reports` is the Report action behind every AI output a
 * student sees -- an Ask AI answer, a quiz, a flashcard deck, or a summary. The server snapshots
 * the reported item itself (`moderation/snapshots.ts`), so the moderation queue holds exactly what
 * the model produced even after the source expires. Priority and the response deadline follow from
 * the reason category (`moderation/reports.ts`); a `child_safety` report lands as urgent.
 *
 * `POST /api/ai/students/{studentId}/messages/{messageId}/report` is the original Ask-only route,
 * kept so app builds already in students' hands keep working. It files the same kind of report
 * with reason category `other`.
 *
 * Both are self-service: the caller must be the student whose output it is, and every content read
 * is scoped to that student. Neither calls the model or draws quota -- and the entitlement gate
 * passes them through, so a student whose AI add-on lapsed can still report what they were shown.
 * A second report of the same item by the same student is 409 AI_ANSWER_REPORTED; an item that
 * does not exist for this student (or a summary no longer in the cache) is 404.
 */

const studentIdParam = z
  .string()
  .uuid()
  .openapi({
    param: { name: "studentId", in: "path" },
    description: "The student reporting their own AI output.",
  });

const reportBodySchema = z
  .object({
    content_type: z.enum(REPORTABLE_CONTENT_TYPES).openapi({
      description: "Which kind of AI output is being reported.",
    }),
    content_id: z
      .string()
      .uuid()
      .openapi({
        description:
          "The reported item: the Ask AI message id, quiz id, flashcard deck id, or -- for a " +
          "summary -- the summarized material's id.",
      }),
    summary_length: z.enum(AI_SUMMARY_LENGTHS).optional().openapi({
      description: "Required when `content_type` is `summary`: the length preset that was shown.",
    }),
    reason_category: z.enum(REPORT_REASON_CATEGORIES).openapi({
      description:
        "Why it is being reported. `child_safety` and `unsafe` are prioritized for the fastest " +
        "response.",
    }),
    reason: z.string().trim().min(1).max(1000).optional().openapi({
      description: "Optional details in the student's own words.",
      example: "This flashcard's answer is wrong.",
    }),
  })
  .refine((body) => body.content_type !== "summary" || body.summary_length !== undefined, {
    message: "summary_length is required when content_type is summary",
    path: ["summary_length"],
  });

const reportResponseSchema = z.object({
  report_id: z.string().uuid(),
  priority: z.enum(REPORT_PRIORITIES),
  respond_by: z.string().datetime().openapi({
    description: "When the school has committed to have reviewed this report by.",
  }),
  message: z.string(),
});

const fileReportRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/reports",
  tags: ["AI"],
  operationId: "reportAiContent",
  summary: "Report AI-generated content for moderation",
  description:
    "Flags an AI answer, quiz, flashcard deck, or summary for review by the school's moderators. " +
    "The server snapshots the reported content itself. Duplicate reports of the same item by the " +
    "same student are refused with 409 AI_ANSWER_REPORTED; an item this student does not own, or " +
    "a summary that is no longer cached, returns 404 RESOURCE_NOT_FOUND.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ studentId: studentIdParam }),
    body: { required: true, content: { "application/json": { schema: reportBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The report was filed.", schema: reportResponseSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const legacyReportRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/messages/{messageId}/report",
  tags: ["AI"],
  operationId: "reportAiAnswer",
  summary: "Report an AI answer for review (Ask AI only; prefer reportAiContent)",
  description:
    "The original Ask AI report route, kept for existing app builds. Equivalent to " +
    "`POST /api/ai/students/{studentId}/reports` with `content_type: ask_answer` and " +
    "`reason_category: other`.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      studentId: studentIdParam,
      messageId: z
        .string()
        .uuid()
        .openapi({
          param: { name: "messageId", in: "path" },
          description: "The AI message being reported.",
        }),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            reason: z.string().trim().min(1).max(1000).openapi({
              description: "The student's stated reason for reporting this answer.",
            }),
          }),
        },
      },
    },
  },
  responses: standardResponses(
    { 201: { description: "The report was filed.", schema: reportResponseSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

interface FileReportInput {
  studentId: string;
  contentType: ReportableContentType;
  contentId: string;
  summaryLength?: AiSummaryLength;
  reasonCategory: ReportReasonCategory;
  reason: string | null;
}

export function aiReportRoutes(deps: {
  database: Database;
  /** The summary cache the summarize route writes; the only place a summary's text exists. */
  summaryCache: SummaryCache;
}): OpenAPIHono<AppEnv> {
  const { database, summaryCache } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/ai/students/:studentId/reports", auditAction("insert", "ai_content_reports"));
  routes.use(
    "/api/ai/students/:studentId/messages/:messageId/report",
    auditAction("insert", "ai_content_reports"),
  );

  async function fileReport(c: Context<AppEnv>, input: FileReportInput) {
    const auth = requireAuth(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    if (auth.userId !== input.studentId) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.AUTHZ_FORBIDDEN,
        getLocalizedMessage(ERROR_CODES.AUTHZ_FORBIDDEN, locale),
      );
    }

    const priority = reportPriority(input.reasonCategory);
    const respondBy = reportRespondBy(priority, new Date());
    const tenant = { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };

    const reportId = await withTenantTx(database, tenant, async (tx) => {
      const snapshot = await loadContentSnapshot(tx, summaryCache, input);
      if (snapshot === null) {
        throw new CodedHttpException(
          404,
          ERROR_CODES.RESOURCE_NOT_FOUND,
          getLocalizedMessage(ERROR_CODES.RESOURCE_NOT_FOUND, locale),
        );
      }
      try {
        return await insertUserReport(tx, {
          schoolId: auth.schoolId,
          studentId: input.studentId,
          reporterId: auth.userId,
          contentType: input.contentType,
          contentId: input.contentId,
          contentSnapshot: snapshot,
          reasonCategory: input.reasonCategory,
          reason: input.reason,
          priority,
          respondBy,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new CodedHttpException(
            409,
            ERROR_CODES.AI_ANSWER_REPORTED,
            getLocalizedMessage(ERROR_CODES.AI_ANSWER_REPORTED, locale),
          );
        }
        throw error;
      }
    });

    if (priority === "urgent") {
      c.get("log")?.error(
        {
          event: "ai_content_report_urgent",
          report_id: reportId,
          school_id: auth.schoolId,
          content_type: input.contentType,
        },
        "urgent AI content report filed",
      );
    }

    return c.json(
      {
        report_id: reportId,
        priority,
        respond_by: respondBy.toISOString(),
        message: getLocalizedMessage(ERROR_CODES.AI_ANSWER_REPORTED, locale),
      },
      201,
    );
  }

  routes.openapi(fileReportRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const body = c.req.valid("json");
    return fileReport(c, {
      studentId,
      contentType: body.content_type,
      contentId: body.content_id,
      summaryLength: body.summary_length,
      reasonCategory: body.reason_category,
      reason: body.reason ?? null,
    });
  });

  routes.openapi(legacyReportRoute, async (c) => {
    const { studentId, messageId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    return fileReport(c, {
      studentId,
      contentType: "ask_answer",
      contentId: messageId,
      reasonCategory: "other",
      reason,
    });
  });

  return routes;
}
