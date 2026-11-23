import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  curriculumTemplateApplyBodySchema,
  curriculumTemplateListSchema,
  curriculumTemplatePlanSchema,
  curriculumTemplatePreviewBodySchema,
  curriculumTemplateQuerySchema,
} from "../curriculum-template-schemas";
import {
  applyCurriculumTemplate,
  listCurriculumTemplates,
  previewCurriculumTemplate,
} from "../curriculum-template-service";
import { yearIdParamSchema } from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

/**
 * Curriculum templates: the built-in grading set-ups (IGCSE, IB, American, ...) and applying one
 * to an academic year's grades. School leadership only (academicConfig:manage), like every other
 * change to the grading configuration.
 */

const TAGS = ["Academic grading"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const listRoute = createRoute({
  method: "get",
  path: "/api/grading/curriculum-templates",
  tags: TAGS,
  operationId: "listCurriculumTemplates",
  summary: "The built-in curriculum templates",
  description:
    "Grade scales, result formats, categories and subject defaults for National percentage, IGCSE, A-Level, BTEC, British Key Stages, IB PYP/MYP/DP, American, French and Irish grading. Boundaries are editable defaults.",
  security,
  request: { query: curriculumTemplateQuerySchema },
  responses: standardResponses(
    { 200: { description: "Templates.", schema: curriculumTemplateListSchema } },
    [400, 401, 403, 500],
  ),
});

const previewRoute = createRoute({
  method: "post",
  path: "/api/grading/years/{yearId}/curriculum-template/preview",
  tags: TAGS,
  operationId: "previewCurriculumTemplate",
  summary: "What applying a curriculum template to grades would do",
  description:
    "Lists the scale, grade programs, descriptor scales and subjects the template would create, change or leave alone. Writes nothing.",
  security,
  request: { params: yearIdParamSchema, body: json(curriculumTemplatePreviewBodySchema) },
  responses: standardResponses(
    { 200: { description: "Plan.", schema: curriculumTemplatePlanSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const applyRoute = createRoute({
  method: "post",
  path: "/api/grading/years/{yearId}/curriculum-template/apply",
  tags: TAGS,
  operationId: "applyCurriculumTemplate",
  summary: "Apply a curriculum template to grades",
  description:
    "Creates or reuses the template's scale, sets each grade program's scale, result format and rounding, and rebuilds the grades' subjects that have no marks. Refused with ACADEMIC_CONFIG_IMPACT_UNCONFIRMED when existing configuration would change and confirm is not true.",
  security,
  request: { params: yearIdParamSchema, body: json(curriculumTemplateApplyBodySchema) },
  responses: standardResponses(
    { 200: { description: "What was applied.", schema: curriculumTemplatePlanSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

export function gradingCurriculumTemplateRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE);

  routes.use("/api/grading/curriculum-templates", manage);
  // The preview writes nothing; it declares the table its apply audits.
  routes.use(
    "/api/grading/years/:yearId/curriculum-template/preview",
    manage,
    auditAction("update", "grade_programs"),
  );
  routes.use(
    "/api/grading/years/:yearId/curriculum-template/apply",
    manage,
    auditAction("update", "grade_programs"),
  );

  routes.openapi(listRoute, (c) => {
    const { locale } = c.req.valid("query");
    return c.json({ templates: listCurriculumTemplates(locale) }, 200);
  });

  routes.openapi(previewRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = requireAuth(c);
    const tenant = { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        previewCurriculumTemplate(tx, tenant.schoolId, yearId, body),
      ),
      200,
    );
  });

  routes.openapi(applyRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = requireAuth(c);
    const tenant = { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        applyCurriculumTemplate(tx, tenant.schoolId, tenant.userId, yearId, body),
      ),
      200,
    );
  });

  return routes;
}
