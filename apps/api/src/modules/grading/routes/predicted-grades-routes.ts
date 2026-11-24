import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { hasPermission, requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  predictedGradesQuerySchema,
  savePredictedGradesBodySchema,
  sectionPredictedGradesSchema,
  studentPredictedGradesSchema,
} from "../predicted-grades-schemas";
import {
  getSectionPredictedGrades,
  getStudentPredictedGrades,
  savePredictedGrades,
} from "../predicted-grades-service";
import { gradingStudentParamSchema, sectionSubjectParamSchema } from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context, MiddlewareHandler } from "hono";

const TAGS = ["Results"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const sectionRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/predicted-grades",
  tags: TAGS,
  operationId: "getSectionPredictedGrades",
  summary: "Predicted grades for a section's subject",
  description:
    "Every student taking the subject, with their predicted grade for a term (term_id) or the year (no term_id), and the labels the subject's grade scale allows. The subject's teachers in the section and school leadership; the subject's coordinator reads them too (editable false).",
  security,
  request: { params: sectionSubjectParamSchema, query: predictedGradesQuerySchema },
  responses: standardResponses(
    { 200: { description: "Predicted grades.", schema: sectionPredictedGradesSchema } },
    [401, 403, 404, 500],
  ),
});

const saveRoute = createRoute({
  method: "put",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/predicted-grades",
  tags: TAGS,
  operationId: "savePredictedGrades",
  summary: "Set students' predicted grades in a subject",
  description:
    "The subject's teachers in the section and school leadership. A label must be one of the subject's grade scale bands when it has a scale; null or blank removes a prediction. Refused with PREDICTED_GRADES_DISABLED unless the grade's program has predicted grades switched on, and with ACADEMIC_CONFIG_LOCKED once the year is finalized or archived. Every save is audited with the old and new values.",
  security,
  request: { params: sectionSubjectParamSchema, body: json(savePredictedGradesBodySchema) },
  responses: standardResponses(
    { 200: { description: "The refreshed predictions.", schema: sectionPredictedGradesSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const studentRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/predicted-grades",
  tags: TAGS,
  operationId: "getStudentPredictedGrades",
  summary: "A student's predicted grades, by academic year",
  description:
    "School leadership and the student's teachers see every prediction. The student and their linked parents see a year's predictions only while its grade program shows them to students and parents, and never the teacher's note.",
  security,
  request: { params: gradingStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "Predicted grades.", schema: studentPredictedGradesSchema } },
    [401, 403, 404, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/**
 * Teachers write with grade:update; principals, who hold result:finalize but not grade:update,
 * with that (as for report card notes). The service then checks who teaches the section's subject.
 */
const requirePredictionWriter: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "PUT") {
    const auth = requireAuth(c);
    if (
      !hasPermission(auth.roles, PERMISSIONS.GRADE_UPDATE) &&
      !hasPermission(auth.roles, PERMISSIONS.RESULT_FINALIZE)
    ) {
      throw new HTTPException(403, { message: "Insufficient permissions for this operation" });
    }
  }
  await next();
};

export function gradingPredictedGradesRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/predicted-grades",
    requirePermission(PERMISSIONS.GRADE_READ),
    requirePredictionWriter,
    auditAction("update", "student_predicted_grades"),
  );
  routes.use(
    "/api/grading/students/:studentId/predicted-grades",
    requirePermission(PERMISSIONS.GRADE_READ),
  );

  routes.openapi(sectionRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const { term_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getSectionPredictedGrades(tx, tenant.schoolId, sectionId, subjectId, term_id ?? null),
      ),
      200,
    );
  });

  routes.openapi(saveRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, async (tx) => {
        await savePredictedGrades(
          tx,
          tenant.schoolId,
          tenant.userId,
          sectionId,
          subjectId,
          body.term_id,
          body.grades,
        );
        return getSectionPredictedGrades(tx, tenant.schoolId, sectionId, subjectId, body.term_id);
      }),
      200,
    );
  });

  routes.openapi(studentRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getStudentPredictedGrades(tx, tenant.schoolId, studentId),
      ),
      200,
    );
  });

  return routes;
}
