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
  saveDiplomaCoreBodySchema,
  sectionDiplomaCoreSchema,
  studentDiplomaSchema,
} from "../diploma-schemas";
import {
  getSectionDiplomaCore,
  getStudentDiploma,
  saveSectionDiplomaCore,
} from "../diploma-service";
import { gradingSectionParamSchema, gradingStudentParamSchema } from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context, MiddlewareHandler } from "hono";

const TAGS = ["Results"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const sectionRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/diploma-core",
  tags: TAGS,
  operationId: "getSectionDiplomaCore",
  summary: "IB Diploma core grades for a section",
  description:
    "Every student of the section with their final and predicted Theory of Knowledge and Extended Essay grades (A-E) and CAS completion for the year. The section's teachers and school leadership.",
  security,
  request: { params: gradingSectionParamSchema },
  responses: standardResponses(
    { 200: { description: "Core grades.", schema: sectionDiplomaCoreSchema } },
    [401, 403, 404, 500],
  ),
});

const saveRoute = createRoute({
  method: "put",
  path: "/api/grading/sections/{sectionId}/diploma-core",
  tags: TAGS,
  operationId: "saveSectionDiplomaCore",
  summary: "Set students' IB Diploma core grades",
  description:
    "The section's teachers (TOK and EE supervisors) and school leadership. Saves the final or predicted TOK/EE grades and CAS completion; all three null removes a student's row. Refused with DIPLOMA_TOTAL_DISABLED unless the grade's result is the points total, with PREDICTED_GRADES_DISABLED for predicted grades while predicted grades are off, and with ACADEMIC_CONFIG_LOCKED once the year is finalized or archived. Final grades are copied onto results at finalization; a change after finalization reaches the result through a correction. Every save is audited with the old and new values.",
  security,
  request: { params: gradingSectionParamSchema, body: json(saveDiplomaCoreBodySchema) },
  responses: standardResponses(
    { 200: { description: "The refreshed core grades.", schema: sectionDiplomaCoreSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const studentRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/diploma",
  tags: TAGS,
  operationId: "getStudentDiploma",
  summary: "A student's IB Diploma core grades and predicted total, by academic year",
  description:
    "Years whose grade uses the IB Diploma total. Staff see the final and predicted core grades and the predicted total; the student and linked parents see the predicted core grades and total only while the grade shows predicted grades to them, and the final total on their finalized results.",
  security,
  request: { params: gradingStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "Diploma core and prediction.", schema: studentDiplomaSchema } },
    [401, 403, 404, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/**
 * Teachers write with grade:update; principals, who hold result:finalize but not grade:update,
 * with that (as for predicted grades). The service then checks who teaches in the section.
 */
const requireCoreWriter: MiddlewareHandler<AppEnv> = async (c, next) => {
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

/** IB Diploma total (000263): core grade entry and the student's diploma prediction. */
export function gradingDiplomaRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    "/api/grading/sections/:sectionId/diploma-core",
    requirePermission(PERMISSIONS.GRADE_READ),
    requireCoreWriter,
    auditAction("update", "student_diploma_core_grades"),
  );
  routes.use("/api/grading/students/:studentId/diploma", requirePermission(PERMISSIONS.GRADE_READ));

  routes.openapi(sectionRoute, async (c) => {
    const { sectionId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getSectionDiplomaCore(tx, tenant.schoolId, sectionId),
      ),
      200,
    );
  });

  routes.openapi(saveRoute, async (c) => {
    const { sectionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, async (tx) => {
        await saveSectionDiplomaCore(
          tx,
          tenant.schoolId,
          tenant.userId,
          sectionId,
          body.kind,
          body.grades,
        );
        return getSectionDiplomaCore(tx, tenant.schoolId, sectionId);
      }),
      200,
    );
  });

  routes.openapi(studentRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getStudentDiploma(tx, tenant.schoolId, studentId),
      ),
      200,
    );
  });

  return routes;
}
