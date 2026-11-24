import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { onlyMethods } from "../../middleware/only-methods";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";

import {
  assignCandidateNumbersBodySchema,
  assignCandidateNumbersResultSchema,
  bulkCreateExamEntriesBodySchema,
  bulkCreateExamEntriesResultSchema,
  changeExamEntryStatusBodySchema,
  changeExamEntryStatusResultSchema,
  createExamSessionBodySchema,
  examEntryExportQuerySchema,
  examEntryIdParamSchema,
  examEntrySchema,
  examEntryStudentParamSchema,
  examSessionEntriesSchema,
  examSessionIdParamSchema,
  examSessionListQuerySchema,
  examSessionListSchema,
  examSessionSchema,
  studentExamEntryListSchema,
  updateExamEntryBodySchema,
  updateExamSessionBodySchema,
} from "./schemas";
import {
  assignCandidateNumbers,
  bulkCreateExamEntries,
  changeExamEntryStatus,
  createExamSession,
  deleteExamEntry,
  deleteExamSession,
  exportSessionEntriesCsv,
  listExamSessions,
  listSessionEntries,
  listStudentExamEntries,
  updateExamEntry,
  updateExamSession,
} from "./service";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * Exam entries (000262). School leadership (academicConfig:manage) runs sessions of the school's
 * external exams and enters students; staff who read the catalogue (academicConfig:read) see the
 * sessions; anyone with grade:read sees a student's entries when they may read the student
 * (leadership, the student's teachers, the student, linked parents) -- checked in the service and
 * by RLS.
 */

const TAGS = ["Exam entries"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const listSessionsRoute = createRoute({
  method: "get",
  path: "/api/grading/external-exam-sessions",
  tags: TAGS,
  operationId: "listExamSessions",
  summary: "Sessions of the school's external exams",
  description: "Latest first, with how many entries each has per status.",
  security,
  request: { query: examSessionListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Sessions.", schema: examSessionListSchema } },
    [400, 401, 403, 500],
  ),
});

const createSessionRoute = createRoute({
  method: "post",
  path: "/api/grading/external-exam-sessions",
  tags: TAGS,
  operationId: "createExamSession",
  summary: "Add a session of an external exam",
  description:
    "409 CONFLICT_DUPLICATE_ENTRY when the exam already has a session of that series; 409 when the " +
    "exam is archived.",
  security,
  request: { body: json(createExamSessionBodySchema) },
  responses: standardResponses(
    { 201: { description: "The new session.", schema: examSessionSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const updateSessionRoute = createRoute({
  method: "put",
  path: "/api/grading/external-exam-sessions/{sessionId}",
  tags: TAGS,
  operationId: "updateExamSession",
  summary: "Replace a session's series, dates and note",
  security,
  request: { params: examSessionIdParamSchema, body: json(updateExamSessionBodySchema) },
  responses: standardResponses(
    { 200: { description: "The session.", schema: examSessionSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/api/grading/external-exam-sessions/{sessionId}",
  tags: TAGS,
  operationId: "deleteExamSession",
  summary: "Delete a session nobody is entered in",
  description: "409 once the session has entries, drafts included.",
  security,
  request: { params: examSessionIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

const listEntriesRoute = createRoute({
  method: "get",
  path: "/api/grading/external-exam-sessions/{sessionId}/entries",
  tags: TAGS,
  operationId: "listExamSessionEntries",
  summary: "A session's entries and how many students take each subject",
  security,
  request: { params: examSessionIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The session and its entries.", schema: examSessionEntriesSchema } },
    [401, 403, 404, 500],
  ),
});

const bulkCreateRoute = createRoute({
  method: "post",
  path: "/api/grading/external-exam-sessions/{sessionId}/entries",
  tags: TAGS,
  operationId: "createExamEntries",
  summary: "Enter students in bulk: a list, a section or a grade",
  description:
    "New students get an entry with the subjects; students already entered get the subjects they " +
    "lack; withdrawn entries are skipped. 409 when the exam is archived.",
  security,
  request: { params: examSessionIdParamSchema, body: json(bulkCreateExamEntriesBodySchema) },
  responses: standardResponses(
    { 200: { description: "What changed.", schema: bulkCreateExamEntriesResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const changeStatusRoute = createRoute({
  method: "post",
  path: "/api/grading/external-exam-sessions/{sessionId}/entries/status",
  tags: TAGS,
  operationId: "changeExamEntryStatus",
  summary: "Mark entries entered, withdraw or reinstate them",
  description: "All or none: 409 when one of them cannot move to the status.",
  security,
  request: { params: examSessionIdParamSchema, body: json(changeExamEntryStatusBodySchema) },
  responses: standardResponses(
    { 200: { description: "How many changed.", schema: changeExamEntryStatusResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const assignNumbersRoute = createRoute({
  method: "post",
  path: "/api/grading/external-exam-sessions/{sessionId}/candidate-numbers",
  tags: TAGS,
  operationId: "assignExamCandidateNumbers",
  summary: "Number the entries that have no candidate number",
  security,
  request: { params: examSessionIdParamSchema, body: json(assignCandidateNumbersBodySchema) },
  responses: standardResponses(
    { 200: { description: "How many were numbered.", schema: assignCandidateNumbersResultSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const exportRoute = createRoute({
  method: "get",
  path: "/api/grading/external-exam-sessions/{sessionId}/entries/export",
  tags: TAGS,
  operationId: "exportExamSessionEntries",
  summary: "The entry list for the exam board, as CSV",
  description:
    "One row per entered subject (UTF-8 with a byte-order mark), by candidate number. Drafts are " +
    "left out unless include_drafts is true. Audited.",
  security,
  request: { params: examSessionIdParamSchema, query: examEntryExportQuerySchema },
  responses: {
    200: {
      description: "The CSV file.",
      headers: requestIdHeaders,
      content: { "text/csv": { schema: { type: "string" } } },
    },
    ...standardResponses({}, [400, 401, 403, 404, 500]),
  },
});

const updateEntryRoute = createRoute({
  method: "put",
  path: "/api/grading/external-exam-entries/{entryId}",
  tags: TAGS,
  operationId: "updateExamEntry",
  summary: "Replace an entry's candidate number, note and subjects",
  description: "409 CONFLICT_DUPLICATE_ENTRY when the candidate number is used in the session.",
  security,
  request: { params: examEntryIdParamSchema, body: json(updateExamEntryBodySchema) },
  responses: standardResponses(
    { 200: { description: "The entry.", schema: examEntrySchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteEntryRoute = createRoute({
  method: "delete",
  path: "/api/grading/external-exam-entries/{entryId}",
  tags: TAGS,
  operationId: "deleteExamEntry",
  summary: "Delete a draft entry",
  description: "409 for an entry sent to the board: withdraw it instead.",
  security,
  request: { params: examEntryIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

const studentEntriesRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/external-exam-entries",
  tags: TAGS,
  operationId: "listStudentExamEntries",
  summary: "A student's exam entries",
  description:
    "Entries sent to the board (entered or withdrawn), latest session first. School leadership, " +
    "the student's teachers, the student, or a linked parent.",
  security,
  request: { params: examEntryStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "Entries.", schema: studentExamEntryListSchema } },
    [401, 403, 404, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

export function examEntryRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const readCatalogue = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ);
  const manage = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE);
  const readGrades = requirePermission(PERMISSIONS.GRADE_READ);

  routes.use(
    "/api/grading/external-exam-sessions",
    onlyMethods(["GET"], readCatalogue),
    onlyMethods(["POST"], manage),
    auditAction("insert", "external_exam_sessions"),
  );
  routes.on(
    "PUT",
    "/api/grading/external-exam-sessions/:sessionId",
    manage,
    auditAction("update", "external_exam_sessions"),
  );
  routes.on(
    "DELETE",
    "/api/grading/external-exam-sessions/:sessionId",
    manage,
    auditAction("delete", "external_exam_sessions"),
  );
  // The entry list is the school's own planning: leadership only, like every write here.
  routes.on("GET", "/api/grading/external-exam-sessions/:sessionId/entries", manage);
  routes.on("GET", "/api/grading/external-exam-sessions/:sessionId/entries/export", manage);
  routes.on(
    "POST",
    "/api/grading/external-exam-sessions/:sessionId/entries",
    manage,
    auditAction("insert", "external_exam_entries"),
  );
  routes.on(
    "POST",
    "/api/grading/external-exam-sessions/:sessionId/entries/status",
    manage,
    auditAction("update", "external_exam_entries"),
  );
  routes.on(
    "POST",
    "/api/grading/external-exam-sessions/:sessionId/candidate-numbers",
    manage,
    auditAction("update", "external_exam_entries"),
  );
  routes.on(
    "PUT",
    "/api/grading/external-exam-entries/:entryId",
    manage,
    auditAction("update", "external_exam_entries"),
  );
  routes.on(
    "DELETE",
    "/api/grading/external-exam-entries/:entryId",
    manage,
    auditAction("delete", "external_exam_entries"),
  );
  routes.on("GET", "/api/grading/students/:studentId/external-exam-entries", readGrades);

  routes.openapi(listSessionsRoute, async (c) => {
    const { exam_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    const sessions = await withTenantTx(database, tenant, (tx) =>
      listExamSessions(tx, tenant.schoolId, exam_id),
    );
    return c.json({ sessions }, 200);
  });

  routes.openapi(createSessionRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => createExamSession(tx, tenant.schoolId, body)),
      201,
    );
  });

  routes.openapi(updateSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateExamSession(tx, tenant.schoolId, sessionId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) => deleteExamSession(tx, tenant.schoolId, sessionId));
    return c.body(null, 204);
  });

  routes.openapi(listEntriesRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        listSessionEntries(tx, tenant.schoolId, sessionId),
      ),
      200,
    );
  });

  routes.openapi(bulkCreateRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        bulkCreateExamEntries(tx, tenant.schoolId, tenant.userId, sessionId, body),
      ),
      200,
    );
  });

  routes.openapi(changeStatusRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        changeExamEntryStatus(tx, tenant.schoolId, sessionId, body),
      ),
      200,
    );
  });

  routes.openapi(assignNumbersRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        assignCandidateNumbers(tx, tenant.schoolId, sessionId, body),
      ),
      200,
    );
  });

  routes.openapi(exportRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const { include_drafts } = c.req.valid("query");
    const tenant = tenantFrom(c);
    const file = await withTenantTx(database, tenant, (tx) =>
      exportSessionEntriesCsv(tx, tenant.schoolId, sessionId, include_drafts),
    );
    return new Response(file.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  routes.openapi(updateEntryRoute, async (c) => {
    const { entryId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateExamEntry(tx, tenant.schoolId, entryId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteEntryRoute, async (c) => {
    const { entryId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) => deleteExamEntry(tx, tenant.schoolId, entryId));
    return c.body(null, 204);
  });

  routes.openapi(studentEntriesRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const entries = await withTenantTx(database, tenant, (tx) =>
      listStudentExamEntries(tx, tenant.schoolId, studentId),
    );
    return c.json({ entries }, 200);
  });

  return routes;
}
