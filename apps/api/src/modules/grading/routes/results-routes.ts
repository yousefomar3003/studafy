import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  certificateReadiness,
  getCertificate,
  issueCertificates,
  listCertificates,
  reissueCertificate,
  revokeCertificate,
} from "../certificate-service";
import {
  computationView,
  computeSection,
  correctFinalization,
  finalizeSection,
  listFinalizations,
  listStudentResults,
  readFinalizationResults,
  requireFinalization,
} from "../results-service";
import {
  certificateIdParamSchema,
  certificateListSchema,
  certificateQuerySchema,
  certificateSchema,
  correctionBodySchema,
  finalizationDetailSchema,
  finalizationIdParamSchema,
  finalizationListSchema,
  finalizationQuerySchema,
  finalizationSchema,
  finalizeBodySchema,
  gradingSectionParamSchema,
  gradingStudentParamSchema,
  issueCertificatesBodySchema,
  issueCertificatesResultSchema,
  periodQuerySchema,
  readinessSchema,
  reasonBodySchema,
  resultPreviewSchema,
  studentResultsSchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { FinalizationRow } from "../results-service";
import type { Context } from "hono";
import type { TransactionSql } from "postgres";

const TAGS = ["Results"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const previewRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/results/preview",
  tags: TAGS,
  operationId: "previewSectionResults",
  summary: "What finalizing a section's results would produce",
  description:
    "Computed now with the live configuration; nothing is stored. term_id for a term report, omitted for the year.",
  security,
  request: { params: gradingSectionParamSchema, query: periodQuerySchema },
  responses: standardResponses(
    { 200: { description: "Preview.", schema: resultPreviewSchema } },
    [401, 403, 404, 500],
  ),
});

const finalizeRoute = createRoute({
  method: "post",
  path: "/api/grading/sections/{sectionId}/results/finalize",
  tags: TAGS,
  operationId: "finalizeSectionResults",
  summary: "Finalize a section's term or annual results",
  description:
    "Stores an immutable snapshot (rules and results) per student and subject. Refused while mark sheets await approval or results are incomplete (unless allow_incomplete).",
  security,
  request: { params: gradingSectionParamSchema, body: json(finalizeBodySchema) },
  responses: standardResponses(
    { 201: { description: "Finalization.", schema: finalizationSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listFinalizationsRoute = createRoute({
  method: "get",
  path: "/api/grading/finalizations",
  tags: TAGS,
  operationId: "listResultFinalizations",
  summary: "Finalized results, including superseded versions",
  description: "Filter by academic year and/or section.",
  security,
  request: { query: finalizationQuerySchema },
  responses: standardResponses(
    { 200: { description: "Finalizations.", schema: finalizationListSchema } },
    [401, 403, 500],
  ),
});

const finalizationRoute = createRoute({
  method: "get",
  path: "/api/grading/finalizations/{finalizationId}",
  tags: TAGS,
  operationId: "getResultFinalization",
  summary: "One finalization's stored results",
  description: "Read from the stored snapshot, never recomputed.",
  security,
  request: { params: finalizationIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Results.", schema: finalizationDetailSchema } },
    [401, 403, 404, 500],
  ),
});

const correctionRoute = createRoute({
  method: "post",
  path: "/api/grading/finalizations/{finalizationId}/corrections",
  tags: TAGS,
  operationId: "correctFinalizedResults",
  summary: "Correct finalized results",
  description:
    "Applies corrected marks and recomputes with the configuration the results were finalized under, writing a new version. The old version and its certificates are kept.",
  security,
  request: { params: finalizationIdParamSchema, body: json(correctionBodySchema) },
  responses: standardResponses(
    { 201: { description: "New version.", schema: finalizationSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const readinessRoute = createRoute({
  method: "get",
  path: "/api/grading/finalizations/{finalizationId}/certificates/readiness",
  tags: TAGS,
  operationId: "getCertificateReadiness",
  summary: "Who can receive a certificate or report card",
  description:
    "ready, issued, needs_reissue (results corrected since) or blocked (incomplete, with reasons).",
  security,
  request: { params: finalizationIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Readiness.", schema: readinessSchema } },
    [401, 403, 404, 500],
  ),
});

const issueRoute = createRoute({
  method: "post",
  path: "/api/grading/finalizations/{finalizationId}/certificates",
  tags: TAGS,
  operationId: "issueCertificates",
  summary: "Issue certificates or report cards",
  description:
    "Annual finalizations issue certificates, term finalizations report cards. Incomplete results are never issued.",
  security,
  request: { params: finalizationIdParamSchema, body: json(issueCertificatesBodySchema) },
  responses: standardResponses(
    { 201: { description: "Issued.", schema: issueCertificatesResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listCertificatesRoute = createRoute({
  method: "get",
  path: "/api/grading/certificates",
  tags: TAGS,
  operationId: "listAcademicCertificates",
  summary: "Issued certificates and report cards",
  description: "Including superseded and revoked ones.",
  security,
  request: { query: certificateQuerySchema },
  responses: standardResponses(
    { 200: { description: "Certificates.", schema: certificateListSchema } },
    [401, 403, 500],
  ),
});

const certificateRoute = createRoute({
  method: "get",
  path: "/api/grading/certificates/{certificateId}",
  tags: TAGS,
  operationId: "getAcademicCertificate",
  summary: "A certificate exactly as issued",
  description: "School leadership, the student, or a linked parent.",
  security,
  request: { params: certificateIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Certificate.", schema: certificateSchema } },
    [401, 403, 404, 500],
  ),
});

const reissueRoute = createRoute({
  method: "post",
  path: "/api/grading/certificates/{certificateId}/reissue",
  tags: TAGS,
  operationId: "reissueAcademicCertificate",
  summary: "Reissue a certificate from the current results",
  description: "The old certificate is kept as superseded; the new one records why.",
  security,
  request: { params: certificateIdParamSchema, body: json(reasonBodySchema) },
  responses: standardResponses(
    { 201: { description: "New certificate.", schema: certificateSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const revokeRoute = createRoute({
  method: "post",
  path: "/api/grading/certificates/{certificateId}/revoke",
  tags: TAGS,
  operationId: "revokeAcademicCertificate",
  summary: "Revoke a certificate",
  description: "Kept on record as revoked, with the reason.",
  security,
  request: { params: certificateIdParamSchema, body: json(reasonBodySchema) },
  responses: standardResponses(
    { 200: { description: "Revoked certificate.", schema: certificateSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const studentResultsRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/results",
  tags: TAGS,
  operationId: "listStudentFinalizedResults",
  summary: "A student's finalized results",
  description:
    "Only finalized, current versions. School leadership, the student, or a linked parent.",
  security,
  request: { params: gradingStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "Results.", schema: studentResultsSchema } },
    [401, 403, 500],
  ),
});

const studentCertificatesRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/certificates",
  tags: TAGS,
  operationId: "listStudentCertificates",
  summary: "A student's certificates and report cards",
  description: "School leadership, the student, or a linked parent.",
  security,
  request: { params: gradingStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "Certificates.", schema: certificateListSchema } },
    [401, 403, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function finalizationJson(row: FinalizationRow) {
  return {
    ...row,
    finalized_at: row.finalized_at.toISOString(),
    superseded_at: row.superseded_at?.toISOString() ?? null,
  };
}

/** Leadership, the student themself, or a linked parent. */
async function assertStudentAccess(tx: TransactionSql, studentId: string): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT (app.current_user_is_school_admin() OR app.is_related_to_student(${studentId}::uuid)) AS allowed
  `;
  if (!row?.allowed) throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
}

export function gradingResultsRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const finalize = requirePermission(PERMISSIONS.RESULT_FINALIZE);
  const certify = requirePermission(PERMISSIONS.ACADEMIC_CERTIFICATE_ISSUE);
  routes.use("/api/grading/sections/:sectionId/results/preview", finalize);
  routes.use(
    "/api/grading/sections/:sectionId/results/finalize",
    finalize,
    auditAction("insert", "result_finalizations"),
  );
  routes.use("/api/grading/finalizations", finalize);
  routes.use("/api/grading/finalizations/:finalizationId", finalize);
  routes.use(
    "/api/grading/finalizations/:finalizationId/corrections",
    finalize,
    auditAction("update", "result_finalizations"),
  );
  routes.use("/api/grading/finalizations/:finalizationId/certificates/readiness", certify);
  routes.use(
    "/api/grading/finalizations/:finalizationId/certificates",
    certify,
    auditAction("insert", "certificates"),
  );
  routes.use("/api/grading/certificates", certify);
  routes.use("/api/grading/certificates/:certificateId", requirePermission(PERMISSIONS.GRADE_READ));
  routes.use(
    "/api/grading/certificates/:certificateId/reissue",
    certify,
    auditAction("insert", "certificates"),
  );
  routes.use(
    "/api/grading/certificates/:certificateId/revoke",
    certify,
    auditAction("update", "certificates"),
  );
  routes.use("/api/grading/students/:studentId/results", requirePermission(PERMISSIONS.GRADE_READ));
  routes.use(
    "/api/grading/students/:studentId/certificates",
    requirePermission(PERMISSIONS.GRADE_READ),
  );

  routes.openapi(previewRoute, async (c) => {
    const { sectionId } = c.req.valid("param");
    const { term_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    const computation = await withTenantTx(database, tenant, (tx) =>
      computeSection(tx, tenant.schoolId, sectionId, term_id ?? null),
    );
    return c.json(computationView(computation), 200);
  });

  routes.openapi(finalizeRoute, async (c) => {
    const { sectionId } = c.req.valid("param");
    const { term_id, allow_incomplete } = c.req.valid("json");
    const tenant = tenantFrom(c);
    const row = await withTenantTx(database, tenant, (tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.userId, sectionId, term_id, {
        allowIncomplete: allow_incomplete,
      }),
    );
    return c.json(finalizationJson(row), 201);
  });

  routes.openapi(listFinalizationsRoute, async (c) => {
    const query = c.req.valid("query");
    const tenant = tenantFrom(c);
    const rows = await withTenantTx(database, tenant, (tx) =>
      listFinalizations(tx, tenant.schoolId, {
        yearId: query.academic_year_id,
        sectionId: query.section_id,
      }),
    );
    return c.json(
      { finalizations: rows.map((row) => ({ ...row, ...finalizationJson(row) })) },
      200,
    );
  });

  routes.openapi(finalizationRoute, async (c) => {
    const { finalizationId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const detail = await withTenantTx(database, tenant, async (tx) => ({
      finalization: finalizationJson(
        await requireFinalization(tx, tenant.schoolId, finalizationId),
      ),
      results: await readFinalizationResults(tx, tenant.schoolId, finalizationId),
    }));
    return c.json(detail, 200);
  });

  routes.openapi(correctionRoute, async (c) => {
    const { finalizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    const row = await withTenantTx(database, tenant, (tx) =>
      correctFinalization(tx, tenant.schoolId, tenant.userId, finalizationId, body),
    );
    return c.json(finalizationJson(row), 201);
  });

  routes.openapi(readinessRoute, async (c) => {
    const { finalizationId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const students = await withTenantTx(database, tenant, (tx) =>
      certificateReadiness(tx, tenant.schoolId, finalizationId),
    );
    return c.json({ students }, 200);
  });

  routes.openapi(issueRoute, async (c) => {
    const { finalizationId } = c.req.valid("param");
    const { student_ids } = c.req.valid("json");
    const tenant = tenantFrom(c);
    const result = await withTenantTx(database, tenant, (tx) =>
      issueCertificates(tx, tenant.schoolId, tenant.userId, finalizationId, student_ids),
    );
    return c.json(result, 201);
  });

  routes.openapi(listCertificatesRoute, async (c) => {
    const query = c.req.valid("query");
    const tenant = tenantFrom(c);
    const certificates = await withTenantTx(database, tenant, (tx) =>
      listCertificates(tx, tenant.schoolId, {
        yearId: query.academic_year_id,
        studentId: query.student_id,
        sectionId: query.section_id,
        finalizationId: query.finalization_id,
      }),
    );
    return c.json({ certificates }, 200);
  });

  routes.openapi(certificateRoute, async (c) => {
    const { certificateId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    // RLS (app.can_read_student_result) hides certificates the caller may not see: a 404, not a 403.
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getCertificate(tx, tenant.schoolId, certificateId),
      ),
      200,
    );
  });

  routes.openapi(reissueRoute, async (c) => {
    const { certificateId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        reissueCertificate(tx, tenant.schoolId, tenant.userId, certificateId, reason),
      ),
      201,
    );
  });

  routes.openapi(revokeRoute, async (c) => {
    const { certificateId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        revokeCertificate(tx, tenant.schoolId, tenant.userId, certificateId, reason),
      ),
      200,
    );
  });

  routes.openapi(studentResultsRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const results = await withTenantTx(database, tenant, async (tx) => {
      await assertStudentAccess(tx, studentId);
      return listStudentResults(tx, tenant.schoolId, studentId);
    });
    return c.json({ results }, 200);
  });

  routes.openapi(studentCertificatesRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const certificates = await withTenantTx(database, tenant, async (tx) => {
      await assertStudentAccess(tx, studentId);
      return listCertificates(tx, tenant.schoolId, { studentId });
    });
    return c.json({ certificates }, 200);
  });

  return routes;
}
