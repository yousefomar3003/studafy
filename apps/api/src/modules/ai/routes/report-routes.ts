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
import { persistAnswerReport } from "../moderation/persistence";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

/**
 * Answer report route: `POST /api/ai/students/{studentId}/messages/{messageId}/report`.
 *
 * A student flags an AI answer for teacher review. The answer may have passed auto-moderation
 * but the student believes it is inappropriate, incorrect, or otherwise worth reviewing. The
 * report is stored in `app.ai_answer_reports` with status `pending`, visible to teachers via
 * a future teacher-facing endpoint (or surfaced in the teacher dashboard's moderation queue).
 *
 * Duplicate reports (same student, same message) are refused with 409 CONFLICT. A nonexistent
 * message returns 404 RESOURCE_NOT_FOUND. The reporter must be the authenticated student — a
 * student cannot report on behalf of another student.
 */

const reportBodySchema = z.object({
  reason: z.string().trim().min(1).max(1000).openapi({
    description: "The student's stated reason for reporting this answer.",
    example: "This answer contains incorrect information about the water cycle.",
  }),
});

const reportParamsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The student reporting the answer.",
    }),
  messageId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "messageId", in: "path" },
      description: "The AI message being reported.",
    }),
});

const reportResponseSchema = z.object({
  report_id: z.string().uuid(),
  message: z.string(),
});

const reportRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/messages/{messageId}/report",
  tags: ["AI"],
  operationId: "reportAiAnswer",
  summary: "Report an AI answer for teacher review",
  description:
    "A student flags an AI-generated answer as inappropriate or incorrect. The report is stored " +
    "for teacher review with status `pending`. Duplicate reports for the same message by the same " +
    "student are refused with 409 CONFLICT. A nonexistent message returns 404 RESOURCE_NOT_FOUND.",
  security: [{ bearerAuth: [] }],
  request: {
    params: reportParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: reportBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The report was created successfully.", schema: reportResponseSchema } },
    [400, 401, 404, 409, 422],
  ),
});

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

export function aiReportRoutes(deps: { database: Database }): OpenAPIHono<AppEnv> {
  const { database } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    "/api/ai/students/:studentId/messages/:messageId/report",
    auditAction("insert", "ai_answer_reports"),
  );

  routes.openapi(reportRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId, messageId } = c.req.valid("param");
    const body = c.req.valid("json");
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    if (auth.userId !== studentId) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.AUTHZ_FORBIDDEN,
        getLocalizedMessage(ERROR_CODES.AUTHZ_FORBIDDEN, locale),
      );
    }

    const result = await withTenantTx(database, tenantFrom(c), async (tx) => {
      // Verify the message exists and belongs to this student.
      const [message] = await tx<{ id: string }[]>`
        SELECT id
        FROM app.ai_messages
        WHERE id = ${messageId}::uuid
      `;
      if (!message) {
        throw new CodedHttpException(
          404,
          ERROR_CODES.RESOURCE_NOT_FOUND,
          getLocalizedMessage(ERROR_CODES.RESOURCE_NOT_FOUND, locale),
        );
      }

      try {
        const reportId = await persistAnswerReport(tx, {
          schoolId: auth.schoolId,
          studentId,
          messageId,
          reporterId: auth.userId,
          reason: body.reason,
        });
        return { reportId };
      } catch (error: unknown) {
        // Unique violation on (message_id, reporter_id) = duplicate report.
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code: string }).code === "23505"
        ) {
          throw new CodedHttpException(
            409,
            ERROR_CODES.AI_ANSWER_REPORTED,
            getLocalizedMessage(ERROR_CODES.AI_ANSWER_REPORTED, locale),
          );
        }
        throw error;
      }
    });

    return c.json(
      {
        report_id: result.reportId,
        message: getLocalizedMessage(ERROR_CODES.AI_ANSWER_REPORTED, locale),
      },
      201,
    );
  });

  return routes;
}
