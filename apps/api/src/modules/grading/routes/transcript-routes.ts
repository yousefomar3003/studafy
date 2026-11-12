import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { gradingStudentParamSchema, reasonBodySchema } from "../schemas";
import {
  transcriptIdParamSchema,
  transcriptListSchema,
  transcriptReadinessSchema,
  transcriptSchema,
} from "../transcript-schemas";
import {
  getTranscript,
  issueTranscript,
  listStudentTranscripts,
  reissueTranscript,
  revokeTranscript,
  transcriptReadiness,
} from "../transcript-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";
import type { TransactionSql } from "postgres";

/**
 * Academic transcripts (000207). School leadership with the certificate permission checks
 * readiness, issues, reissues and revokes; leadership, the student and the student's linked
 * parents read them. RLS (role_scope_visibility on app.transcripts) hides everyone else's.
 */

const TAGS = ["Results"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const readinessRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/transcript-readiness",
  tags: TAGS,
  operationId: "getTranscriptReadiness",
  summary: "Whether a transcript can be issued for a student",
  description:
    "The years a transcript would cover (the current annual result of each academic year), the " +
    "cumulative figures, and why it cannot be issued yet if it cannot.",
  security,
  request: { params: gradingStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "Readiness.", schema: transcriptReadinessSchema } },
    [401, 403, 404, 500],
  ),
});

const issueRoute = createRoute({
  method: "post",
  path: "/api/grading/students/{studentId}/transcripts",
  tags: TAGS,
  operationId: "issueTranscript",
  summary: "Issue a student's transcript",
  description:
    "Renders every finalized end-of-year result into one immutable document with cumulative " +
    "figures. 409 CERTIFICATE_BLOCKED when a covered year is incomplete or there are none; 409 " +
    "CONFLICT_STATE_MISMATCH when the student already has one (reissue it instead).",
  security,
  request: { params: gradingStudentParamSchema },
  responses: standardResponses(
    { 201: { description: "The issued transcript.", schema: transcriptSchema } },
    [401, 403, 404, 409, 500],
  ),
});

const studentTranscriptsRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/transcripts",
  tags: TAGS,
  operationId: "listStudentTranscripts",
  summary: "A student's transcripts",
  description:
    "Newest first, including superseded and revoked ones. School leadership, the student, or a linked parent.",
  security,
  request: { params: gradingStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "Transcripts.", schema: transcriptListSchema } },
    [401, 403, 500],
  ),
});

const transcriptRoute = createRoute({
  method: "get",
  path: "/api/grading/transcripts/{transcriptId}",
  tags: TAGS,
  operationId: "getTranscript",
  summary: "A transcript exactly as issued",
  description: "School leadership, the student, or a linked parent; 404 for anyone else.",
  security,
  request: { params: transcriptIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The transcript.", schema: transcriptSchema } },
    [401, 403, 404, 500],
  ),
});

const reissueRoute = createRoute({
  method: "post",
  path: "/api/grading/transcripts/{transcriptId}/reissue",
  tags: TAGS,
  operationId: "reissueTranscript",
  summary: "Reissue a transcript from the student's current results",
  description:
    "Writes a new transcript (after a correction, or once a newer year is finalized) and marks the " +
    "old one superseded.",
  security,
  request: { params: transcriptIdParamSchema, body: json(reasonBodySchema) },
  responses: standardResponses(
    { 201: { description: "The new transcript.", schema: transcriptSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const revokeRoute = createRoute({
  method: "post",
  path: "/api/grading/transcripts/{transcriptId}/revoke",
  tags: TAGS,
  operationId: "revokeTranscript",
  summary: "Revoke a transcript",
  security,
  request: { params: transcriptIdParamSchema, body: json(reasonBodySchema) },
  responses: standardResponses(
    { 200: { description: "The revoked transcript.", schema: transcriptSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/** Leadership, the student themself, or a linked parent. */
async function assertStudentAccess(tx: TransactionSql, studentId: string): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT (app.current_user_is_school_admin() OR app.is_related_to_student(${studentId}::uuid)) AS allowed
  `;
  if (!row?.allowed) throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
}

export function gradingTranscriptRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const certify = requirePermission(PERMISSIONS.ACADEMIC_CERTIFICATE_ISSUE);
  const read = requirePermission(PERMISSIONS.GRADE_READ);
  routes.use("/api/grading/students/:studentId/transcript-readiness", certify);
  // One path, two methods: listing is for readers, issuing for leadership.
  routes.on("GET", "/api/grading/students/:studentId/transcripts", read);
  routes.on(
    "POST",
    "/api/grading/students/:studentId/transcripts",
    certify,
    auditAction("insert", "transcripts"),
  );
  routes.use("/api/grading/transcripts/:transcriptId", read);
  routes.use(
    "/api/grading/transcripts/:transcriptId/reissue",
    certify,
    auditAction("insert", "transcripts"),
  );
  routes.use(
    "/api/grading/transcripts/:transcriptId/revoke",
    certify,
    auditAction("update", "transcripts"),
  );

  routes.openapi(readinessRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        transcriptReadiness(tx, tenant.schoolId, studentId),
      ),
      200,
    );
  });

  routes.openapi(issueRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        issueTranscript(tx, tenant.schoolId, tenant.userId, studentId),
      ),
      201,
    );
  });

  routes.openapi(studentTranscriptsRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const transcripts = await withTenantTx(database, tenant, async (tx) => {
      await assertStudentAccess(tx, studentId);
      return listStudentTranscripts(tx, tenant.schoolId, studentId);
    });
    return c.json({ transcripts }, 200);
  });

  routes.openapi(transcriptRoute, async (c) => {
    const { transcriptId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    // RLS hides transcripts the caller may not see: a 404, not a 403.
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getTranscript(tx, tenant.schoolId, transcriptId),
      ),
      200,
    );
  });

  routes.openapi(reissueRoute, async (c) => {
    const { transcriptId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        reissueTranscript(tx, tenant.schoolId, tenant.userId, transcriptId, reason),
      ),
      201,
    );
  });

  routes.openapi(revokeRoute, async (c) => {
    const { transcriptId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        revokeTranscript(tx, tenant.schoolId, tenant.userId, transcriptId, reason),
      ),
      200,
    );
  });

  return routes;
}
