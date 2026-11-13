import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { hasPermission, requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { applyPromotion, previewPromotion } from "../promotion-service";
import {
  applyPromotionBodySchema,
  promotionPreviewSchema,
  promotionQuerySchema,
  promotionResultSchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

const previewPromotionRoute = createRoute({
  method: "get",
  path: "/api/academics/promotions/preview",
  tags: ["Academics"],
  operationId: "previewStudentPromotion",
  summary: "Preview moving students to the next year",
  description:
    "Every student placed in a section of the source year, with a proposed destination in the " +
    "target year taken from their current annual result: promoted to the next grade's section " +
    "with the same name, retained in the same grade, graduated from the top grade, awaiting a " +
    "resit, or needing a decision. Students already placed in the target year, or graduated, show " +
    "as done. Nothing is written.",
  security: [{ bearerAuth: [] }],
  request: { query: promotionQuerySchema },
  responses: standardResponses(
    { 200: { description: "The proposed moves.", schema: promotionPreviewSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const applyPromotionRoute = createRoute({
  method: "post",
  path: "/api/academics/promotions/apply",
  tags: ["Academics"],
  operationId: "applyStudentPromotion",
  summary: "Move a batch of students to the next year",
  description:
    "Applies up to 100 decisions: place a student in a target-year section (enrolling them into " +
    "its classes), mark them graduated, or skip them. Each student is applied on its own; a " +
    "refusal is reported in its outcome and does not undo the others. Re-sending the same " +
    "decisions changes nothing. The source year's placements, results and certificates are " +
    "never changed.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: applyPromotionBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "One outcome per decision.", schema: promotionResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

/**
 * "Move students to next year". Web only, and gated on both permissions it combines: placing
 * students in sections (timetable:manage) and the year's academic set-up (academicConfig:manage).
 * Both are held by ORG_ADMIN and PRINCIPAL.
 */
export function promotionRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  for (const path of ["/api/academics/promotions/preview", "/api/academics/promotions/apply"]) {
    routes.use(path, requireChannel(AUTH_CHANNELS.WEB));
    routes.use(path, requirePermission(PERMISSIONS.TIMETABLE_MANAGE));
    routes.use(path, requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE));
  }
  routes.use("/api/academics/promotions/apply", auditAction("update", "student_sections"));

  routes.openapi(previewPromotionRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");
    const preview = await withTenantTx(
      database,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) => previewPromotion(tx, auth.schoolId, query.source_year_id, query.target_year_id),
    );
    // Admission numbers follow the student list's rule: finance-visible only.
    const showAdmission = hasPermission(auth.roles, PERMISSIONS.BILLING_READ);
    return c.json(
      {
        ...preview,
        students: preview.students.map((student) => ({
          ...student,
          admission_number: showAdmission ? student.admission_number : null,
        })),
      },
      200,
    );
  });

  routes.openapi(applyPromotionRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const outcomes = await withTenantTx(
      database,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) =>
        applyPromotion(tx, auth.schoolId, body.source_year_id, body.target_year_id, body.decisions),
    );
    return c.json({ outcomes }, 200);
  });

  return routes;
}
