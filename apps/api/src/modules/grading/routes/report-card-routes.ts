import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { hasPermission, requirePermission, requirePermissionIn } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  getReportCardSettings,
  getSectionReportNotes,
  saveStudentNotes,
  saveSubjectComments,
  updateReportCardSettings,
} from "../report-card-service";
import {
  gradingSectionParamSchema,
  periodQuerySchema,
  reportCardSettingsSchema,
  saveStudentNotesBodySchema,
  saveSubjectCommentsBodySchema,
  sectionReportNotesSchema,
  sectionSubjectParamSchema,
  updateReportCardSettingsBodySchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context, MiddlewareHandler } from "hono";

const TAGS = ["Results"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const settingsRoute = createRoute({
  method: "get",
  path: "/api/grading/report-card-settings",
  tags: TAGS,
  operationId: "getReportCardSettings",
  summary: "Which report card sections the school shows, and its conduct ratings",
  description:
    "Subject comments, the class teacher's and principal's comments, attendance and conduct each default to shown; the conduct list defaults to Excellent / Very good / Good / Needs improvement.",
  security,
  responses: standardResponses(
    { 200: { description: "Settings.", schema: reportCardSettingsSchema } },
    [401, 403, 500],
  ),
});

const updateSettingsRoute = createRoute({
  method: "put",
  path: "/api/grading/report-card-settings",
  tags: TAGS,
  operationId: "updateReportCardSettings",
  summary: "Change which report card sections are shown, or the conduct ratings",
  description:
    "Omitted fields keep their value. conduct_ratings replaces the whole list. Only results finalized afterwards are affected; finalized results and issued certificates keep what they had.",
  security,
  request: { body: json(updateReportCardSettingsBodySchema) },
  responses: standardResponses(
    { 200: { description: "Saved settings.", schema: reportCardSettingsSchema } },
    [400, 401, 403, 500],
  ),
});

const notesRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/report-notes",
  tags: TAGS,
  operationId: "getSectionReportNotes",
  summary: "Draft report card notes for a section and period",
  description:
    "Every student's class teacher comment, principal comment, conduct rating and per-subject comments for a term (term_id) or the year (no term_id). School leadership and teachers of the section.",
  security,
  request: { params: gradingSectionParamSchema, query: periodQuerySchema },
  responses: standardResponses(
    { 200: { description: "Notes.", schema: sectionReportNotesSchema } },
    [401, 403, 404, 500],
  ),
});

const saveNotesRoute = createRoute({
  method: "put",
  path: "/api/grading/sections/{sectionId}/report-notes",
  tags: TAGS,
  operationId: "saveSectionReportNotes",
  summary: "Write class teacher comments, principal comments and conduct ratings",
  description:
    "Omitted fields keep their value; null or blank clears. The principal comment is school leadership's. Refused once the period is finalized (RESULTS_ALREADY_FINALIZED) or while the year is not active.",
  security,
  request: { params: gradingSectionParamSchema, body: json(saveStudentNotesBodySchema) },
  responses: standardResponses(
    { 200: { description: "The refreshed notes.", schema: sectionReportNotesSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const saveCommentsRoute = createRoute({
  method: "put",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/report-comments",
  tags: TAGS,
  operationId: "saveSubjectReportComments",
  summary: "Write a subject's report card comments",
  description:
    "The subject's teachers in the section and school leadership. null or blank clears a comment. Refused once the period is finalized or while the year is not active.",
  security,
  request: { params: sectionSubjectParamSchema, body: json(saveSubjectCommentsBodySchema) },
  responses: standardResponses(
    { 200: { description: "The refreshed notes.", schema: sectionReportNotesSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/** Teachers write with grade:update; principals, who finalize results, with result:finalize. */
const requireNotesWriter: MiddlewareHandler<AppEnv> = async (c, next) => {
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

export function gradingReportCardRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    "/api/grading/report-card-settings",
    requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ),
  );
  routes.use("/api/grading/report-card-settings", async (c, next) => {
    if (c.req.method === "PUT") requirePermissionIn(c, PERMISSIONS.ACADEMIC_CONFIG_MANAGE);
    await next();
  });
  routes.use("/api/grading/report-card-settings", auditAction("update", "report_card_settings"));
  routes.use(
    "/api/grading/sections/:sectionId/report-notes",
    requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ),
    requireNotesWriter,
  );
  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/report-comments",
    requireNotesWriter,
    auditAction("update", "report_subject_comments"),
  );

  routes.openapi(settingsRoute, async (c) => {
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => getReportCardSettings(tx, tenant.schoolId)),
      200,
    );
  });

  routes.openapi(updateSettingsRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateReportCardSettings(tx, tenant.schoolId, body),
      ),
      200,
    );
  });

  routes.openapi(notesRoute, async (c) => {
    const { sectionId } = c.req.valid("param");
    const { term_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getSectionReportNotes(tx, tenant.schoolId, sectionId, term_id ?? null),
      ),
      200,
    );
  });

  routes.openapi(saveNotesRoute, async (c) => {
    const { sectionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, async (tx) => {
        await saveStudentNotes(
          tx,
          tenant.schoolId,
          tenant.userId,
          sectionId,
          body.term_id,
          body.students,
        );
        return getSectionReportNotes(tx, tenant.schoolId, sectionId, body.term_id);
      }),
      200,
    );
  });

  routes.openapi(saveCommentsRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, async (tx) => {
        await saveSubjectComments(
          tx,
          tenant.schoolId,
          tenant.userId,
          sectionId,
          subjectId,
          body.term_id,
          body.comments,
        );
        return getSectionReportNotes(tx, tenant.schoolId, sectionId, body.term_id);
      }),
      200,
    );
  });

  return routes;
}
