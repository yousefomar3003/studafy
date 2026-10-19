import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { requireStorage } from "../../lib/storage";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";
import { provisionTenant } from "../tenancy/provisioning/service";

import { clearApplicantCookie, requireApplicant } from "./applicant-session";
import {
  applicantApplicationSchema,
  applicantMeResponseSchema,
  applicationIdParamSchema,
  applicationListQuerySchema,
  applicationListResponseSchema,
  approveApplicationBodySchema,
  platformApplicationSchema,
  proofUploadBodySchema,
  proofUploadResponseSchema,
  rejectApplicationBodySchema,
  submitApplicationBodySchema,
} from "./schemas";
import {
  approveApplication,
  createProofUploadUrl,
  getApplicantStatus,
  getApplication,
  listApplications,
  rejectApplication,
  submitApplication,
} from "./service";

import type { ApplicantSessionConfig } from "./applicant-session";
import type { Actor } from "./service";
import type { Database } from "../../db/client";
import type { ErpNextClient } from "../../erpnext/client";
import type { StorageService } from "../../lib/storage";
import type { Logger } from "../../logger";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Applicant routes -- authenticated by the applicant session cookie, not a bearer token
// ---------------------------------------------------------------------------

const APPLICANT_TAG = "School applications";

const getMeRoute = createRoute({
  method: "get",
  path: "/api/school-applications/me",
  tags: [APPLICANT_TAG],
  operationId: "getSchoolApplicant",
  summary: "The signed-in applicant and their latest application",
  description:
    "Reads the applicant session cookie set by the sign-up OAuth callback. 401 " +
    "SCHOOL_APPLICATION_SESSION_REQUIRED when there is none.",
  security: [],
  responses: standardResponses(
    {
      200: { description: "Applicant and application status.", schema: applicantMeResponseSchema },
    },
    [401, 429, 500],
  ),
});

const proofUploadRoute = createRoute({
  method: "post",
  path: "/api/school-applications/me/proof-upload-url",
  tags: [APPLICANT_TAG],
  operationId: "createSchoolApplicationProofUploadUrl",
  summary: "Get a pre-signed upload URL for the proof of ownership",
  description:
    "PDF or image, at most 10 MB. PUT the file to `upload_url` with the same Content-Type, then " +
    "pass `storage_key` when submitting the application.",
  security: [],
  request: {
    body: { required: true, content: { "application/json": { schema: proofUploadBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Pre-signed upload URL.", schema: proofUploadResponseSchema } },
    [400, 401, 429, 500, 503],
  ),
});

const submitRoute = createRoute({
  method: "post",
  path: "/api/school-applications/me",
  tags: [APPLICANT_TAG],
  operationId: "submitSchoolApplication",
  summary: "Submit a school sign-up application",
  description:
    "Records the school's details and proof of ownership for review by the Studafy team, who are " +
    "emailed about it. One pending application per sign-in account.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: submitApplicationBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "Application received.", schema: applicantApplicationSchema } },
    [400, 401, 409, 429, 500, 503],
  ),
});

const signOutRoute = createRoute({
  method: "post",
  path: "/api/school-applications/me/sign-out",
  tags: [APPLICANT_TAG],
  operationId: "signOutSchoolApplicant",
  summary: "End the applicant session",
  security: [],
  responses: {
    204: { description: "Signed out.", headers: requestIdHeaders },
    ...standardResponses({}, [429, 500]),
  },
});

/**
 * The applicant's own endpoints. Public as far as the bearer boundary is concerned (jwtAuth.ts),
 * authenticated by the HttpOnly SameSite=Strict applicant cookie instead -- which is also why they
 * are exempt from the double-submit CSRF check (csrf.ts).
 */
export function schoolApplicantRoutes(
  database: Database,
  storage: StorageService | null,
  sessionConfig: ApplicantSessionConfig,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Records intent only: the applicant has no school to audit in; the row itself is the record.
  routes.use("/api/school-applications/me", auditAction("insert", "school_applications"));
  routes.use(
    "/api/school-applications/me/proof-upload-url",
    auditAction("insert", "school_applications"),
  );
  routes.use("/api/school-applications/me/sign-out", auditAction("delete", "school_applications"));

  routes.openapi(getMeRoute, async (c) => {
    const identity = await requireApplicant(c, sessionConfig);
    return c.json(await getApplicantStatus(database, identity), 200);
  });

  routes.openapi(proofUploadRoute, async (c) => {
    await requireApplicant(c, sessionConfig);
    const body = c.req.valid("json");
    const result = await createProofUploadUrl(requireStorage(storage), {
      fileName: body.file_name,
      contentType: body.content_type,
    });
    return c.json(result, 200);
  });

  routes.openapi(submitRoute, async (c) => {
    const identity = await requireApplicant(c, sessionConfig);
    const body = c.req.valid("json");
    const application = await submitApplication(database, requireStorage(storage), identity, {
      applicantName: body.applicant_name,
      applicantJobTitle: body.applicant_job_title,
      applicantPhone: body.applicant_phone,
      schoolName: body.school_name,
      schoolEmail: body.school_email,
      countryId: body.country_id,
      defaultCurrencyId: body.default_currency_id,
      city: body.city,
      address: body.address,
      website: body.website,
      studentCount: body.student_count,
      message: body.message,
      proofStorageKey: body.proof_storage_key,
      proofFileName: body.proof_file_name,
    });
    c.get("log")?.info(
      { event: "school_application_received", application_id: application.id },
      "school application received",
    );
    return c.json(application, 201);
  });

  routes.openapi(signOutRoute, (c) => {
    clearApplicantCookie(c);
    return c.body(null, 204);
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Platform console routes
// ---------------------------------------------------------------------------

const PLATFORM_TAG = "Platform";

const listRoute = createRoute({
  method: "get",
  path: "/api/platform/school-applications",
  tags: [PLATFORM_TAG],
  operationId: "listPlatformSchoolApplications",
  summary: "School sign-up applications",
  description:
    "Paged list of school sign-up applications, newest first, filterable by status and by a " +
    "school/applicant/city search. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { query: applicationListQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of applications.", schema: applicationListResponseSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const getRoute = createRoute({
  method: "get",
  path: "/api/platform/school-applications/{applicationId}",
  tags: [PLATFORM_TAG],
  operationId: "getPlatformSchoolApplication",
  summary: "One school application, with a link to its proof of ownership",
  security: [{ bearerAuth: [] }],
  request: { params: applicationIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The application.", schema: platformApplicationSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const approveRoute = createRoute({
  method: "post",
  path: "/api/platform/school-applications/{applicationId}/approve",
  tags: [PLATFORM_TAG],
  operationId: "approvePlatformSchoolApplication",
  summary: "Approve an application and create the school",
  description:
    "Creates the school (active) with the applicant as its admin, linked to the Google/Microsoft " +
    "account they applied with, then provisions it. The applicant is emailed. Audited.",
  security: [{ bearerAuth: [] }],
  request: {
    params: applicationIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: approveApplicationBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The approved application.", schema: platformApplicationSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const rejectRoute = createRoute({
  method: "post",
  path: "/api/platform/school-applications/{applicationId}/reject",
  tags: [PLATFORM_TAG],
  operationId: "rejectPlatformSchoolApplication",
  summary: "Reject an application",
  description: "The applicant is emailed the reason and may apply again. Audited.",
  security: [{ bearerAuth: [] }],
  request: {
    params: applicationIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: rejectApplicationBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The rejected application.", schema: platformApplicationSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

export interface PlatformApplicationRoutesDeps {
  database: Database;
  storage: StorageService | null;
  logger: Logger;
  erpNextClient: ErpNextClient | null;
}

function actorFrom(c: Context<AppEnv>): Actor {
  const auth = requireAuth(c);
  return { userId: auth.userId, schoolId: auth.schoolId, requestId: c.get("requestId") };
}

/**
 * The console's review queue (`/api/platform/school-applications*`). Same guards as the rest of
 * the platform console: web channel, platform:read, and platform:manage for decisions.
 */
export function platformSchoolApplicationRoutes(
  deps: PlatformApplicationRoutesDeps,
): OpenAPIHono<AppEnv> {
  const { database, storage, logger, erpNextClient } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/platform/school-applications", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/school-applications/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/school-applications", requirePermission(PERMISSIONS.PLATFORM_READ));
  routes.use("/api/platform/school-applications/*", requirePermission(PERMISSIONS.PLATFORM_READ));

  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  routes.use("/api/platform/school-applications/:applicationId/approve", manage);
  routes.use(
    "/api/platform/school-applications/:applicationId/approve",
    auditAction("update", "school_applications"),
  );
  routes.use("/api/platform/school-applications/:applicationId/reject", manage);
  routes.use(
    "/api/platform/school-applications/:applicationId/reject",
    auditAction("update", "school_applications"),
  );

  routes.openapi(listRoute, async (c) => {
    return c.json(await listApplications(database, c.req.valid("query")), 200);
  });

  routes.openapi(getRoute, async (c) => {
    const { applicationId } = c.req.valid("param");
    return c.json(await getApplication(database, storage, applicationId), 200);
  });

  routes.openapi(approveRoute, async (c) => {
    const { applicationId } = c.req.valid("param");
    const { note } = c.req.valid("json");
    const { application, school } = await approveApplication(
      database,
      applicationId,
      note,
      actorFrom(c),
    );

    // Same follow-up as self-registration's email verification: provisioning (trial subscription,
    // ERPNext site) is idempotent, retryable from the provisioning endpoint, and must not fail the
    // decision that has already committed.
    const log = c.get("log") ?? logger;
    provisionTenant(
      database,
      {
        schoolId: school.schoolId,
        slug: school.slug,
        schoolName: school.schoolName,
        countryId: school.countryId,
        country: "",
        defaultCurrencyId: school.defaultCurrencyId,
        currency: "",
        adminUserId: school.adminUserId,
        adminEmail: school.adminEmail,
        tenantContext: { schoolId: school.schoolId, userId: school.adminUserId },
      },
      log,
      erpNextClient,
    ).catch((error: unknown) => {
      log.error(
        { school_id: school.schoolId, error: error instanceof Error ? error.message : "unknown" },
        "provisioning failed after school application approval",
      );
    });

    return c.json(await getApplication(database, storage, application.id), 200);
  });

  routes.openapi(rejectRoute, async (c) => {
    const { applicationId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    await rejectApplication(database, applicationId, reason, actorFrom(c));
    return c.json(await getApplication(database, storage, applicationId), 200);
  });

  return routes;
}
