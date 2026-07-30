import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Validator } from "@seriousme/openapi-schema-validator";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApp } from "../app";
import { createUnusableDatabase } from "../db/unusable";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";
import { KeyStore } from "../modules/auth";

import { buildOpenApiDocument } from "./document";
import { PROBLEM_STATUSES } from "./responses";

/**
 * ST-060: document-wide invariants.
 *
 * These are the actual guarantee behind the contract requirements. standardResponses' type signature
 * makes forgetting the X-Request-Id header or the problem+json envelope awkward, but a hand-written
 * object literal still satisfies RouteConfig — so the enforcement has to be a walk of the generated
 * document, which is what this file is.
 *
 * The sample is three operations, and that is worth being honest about: "every operation documents
 * problem+json" is currently three assertions. The value is as a ratchet — the fourth operation
 * cannot be added without satisfying them.
 */

const COMMITTED_SPEC = path.join(import.meta.dir, "..", "..", "openapi.json");

/** The extension the generator prepends. Not part of the document zod-to-openapi builds. */
const BANNER_KEY = "x-generated-by";

const document = await buildOpenApiDocument();

/**
 * The document as JSON — exactly what the generator writes to disk and the server puts on the wire.
 *
 * Every assertion below runs against this rather than the in-memory object, and that is deliberate:
 * JSON.stringify drops undefined-valued keys and anything non-serializable, so this is the artifact
 * itself rather than an object that merely resembles it. It also gives the validator the plain
 * index-signature object it expects.
 */
const serialized = JSON.parse(JSON.stringify(document)) as Record<string, never>;

interface Operation {
  operationId?: string;
  tags?: string[];
  security?: unknown[];
  responses: Record<string, ResponseObject>;
}

interface ResponseObject {
  headers?: Record<string, { required?: boolean; schema?: { format?: string } }>;
  content?: Record<string, { schema?: { $ref?: string } }>;
}

/** Every (path, method, operation) in the document, so a test can walk it without nesting loops. */
const operations: { path: string; method: string; operation: Operation }[] = Object.entries(
  document.paths ?? {},
).flatMap(([routePath, item]) =>
  Object.entries(item as Record<string, Operation>)
    // A path item can hold non-operation members (parameters, summary); only verbs are operations.
    .filter(([method]) =>
      ["get", "put", "post", "delete", "patch", "options", "head"].includes(method),
    )
    .map(([method, operation]) => ({ path: routePath, method, operation })),
);

describe("structure", () => {
  test("is a structurally valid OpenAPI 3.1 document", async () => {
    const validator = new Validator();

    const result = await validator.validate(serialized);

    // The errors are the useful part of a failure; toBe(true) alone would say only "no".
    expect(result.errors ?? [], JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.valid).toBe(true);
    // `valid` alone would also pass a 3.0 document. The ticket asks for 3.1 specifically, and the
    // nullable type unions the components rely on are 3.1-only syntax.
    expect(validator.version).toBe("3.1");
  });

  test("declares OpenAPI 3.1.0", () => {
    expect(document.openapi).toBe("3.1.0");
  });

  // A plain Hono sub-app mounted on an OpenAPIHono keeps serving traffic while contributing nothing
  // to the document, silently. This is the guard against that regression.
  test("contains every mounted route", () => {
    expect(Object.keys(document.paths ?? {}).sort()).toEqual(
      [
        "/.well-known/jwks.json",
        "/api/admin/subscriptions/sync-prices",
        "/api/admin/users/{userId}/devices",
        "/api/admin/users/{userId}/devices/{deviceId}",
        "/api/admin/users/{userId}/providers/{provider}",
        "/api/attendance/records/batch",
        "/api/attendance/records/{recordId}",
        "/api/attendance/records/{recordId}/history",
        "/api/attendance/reports/export",
        "/api/attendance/reports/export/{jobId}",
        "/api/attendance/reports/summary",
        "/api/attendance/reports/trends",
        "/api/attendance/sessions",
        "/api/attendance/sessions/{sessionId}",
        "/api/discipline/incidents",
        "/api/discipline/incidents/{incidentId}",
        "/api/discipline/incidents/{incidentId}/actions",
        "/api/discipline/incidents/{incidentId}/actions/{actionId}",
        "/api/discipline/incidents/{incidentId}/resolve",
        "/api/finance/fee-structures",
        "/api/finance/fee-structures/{feeStructureId}",
        "/api/finance/expenses",
        "/api/finance/expenses/{expenseId}",
        "/api/finance/expenses/summary",
        "/api/finance/expenses/upload-url",
        "/api/finance/expenses/{expenseId}/attachments",
        "/api/finance/scholarship-discounts",
        "/api/finance/scholarship-discounts/awards",
        "/api/finance/scholarship-discounts/awards/{awardId}/confirm",
        "/api/evaluations",
        "/api/evaluations/{evaluationId}",
        "/api/evaluations/{evaluationId}/scores",
        "/api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
        "/api/evaluations/{evaluationId}/share",
        "/api/evaluations/{evaluationId}/submit",
        "/api/evaluations/templates",
        "/api/evaluations/templates/{templateId}",
        "/api/academics/assignments",
        "/api/academics/assignments/{assignmentId}",
        "/api/academics/assignments/{assignmentId}/attachments",
        "/api/academics/assignments/{assignmentId}/attachments/upload-url",
        "/api/academics/assignments/{assignmentId}/attachments/{attachmentId}",
        "/api/academics/assignments/{assignmentId}/submissions",
        "/api/academics/submissions/{submissionId}",
        "/api/academics/submissions/{submissionId}/grade",
        "/api/academics/submissions/{submissionId}/attachments",
        "/api/academics/submissions/{submissionId}/attachments/upload-url",
        "/api/academics/submissions/{submissionId}/attachments/{attachmentId}",
        "/api/academics/classes",
        "/api/academics/classes/{classId}",
        "/api/academics/classes/{classId}/enrollments",
        "/api/academics/classes/{classId}/enrollments/transfer",
        "/api/academics/classes/{classId}/enrollments/{studentId}",
        "/api/academics/courses/{courseId}",
        "/api/academics/exams",
        "/api/academics/exams/{examId}",
        "/api/academics/materials",
        "/api/academics/materials/{materialId}",
        "/api/academics/materials/{materialId}/ai-visible",
        "/api/academics/materials/{materialId}/confirm",
        "/api/academics/materials/upload",
        "/api/grades/config/gradebooks/{gradebookId}/categories",
        "/api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
        "/api/grades/config/gradebooks/{gradebookId}/scheme",
        "/api/grades/config/gradebooks/{gradebookId}/scheme/link",
        "/api/grades/config/schemes",
        "/api/grades/config/schemes/{schemeId}",
        "/api/grades/gradebooks/{gradebookId}/entry",
        "/api/grades/gradebooks/{gradebookId}/grades",
        "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/submit",
        "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/decide",
        "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/unlock",
        "/api/grades/published/students/{studentId}/terms/{termId}",
        "/api/academics/subjects",
        "/api/academics/subjects/{subjectId}",
        "/api/academics/subjects/{subjectId}/courses",
        "/api/academics/slots/{slotId}",
        "/api/academics/timetable-versions",
        "/api/academics/timetable-versions/{versionId}",
        "/api/academics/timetable-versions/{versionId}/approve",
        "/api/academics/timetable-versions/{versionId}/reject",
        "/api/academics/timetable-versions/{versionId}/slots",
        "/api/academics/timetable-versions/{versionId}/submit",
        "/api/academics/timetable-versions/copy",
        "/api/academics/years",
        "/api/academics/years/{yearId}",
        "/api/academics/years/{yearId}/rollover",
        "/api/academics/years/{yearId}/terms",
        "/api/academics/terms/{termId}",
        "/api/auth/devices",
        "/api/auth/devices/{deviceId}",
        "/api/auth/devices/{deviceId}/sessions",
        "/api/auth/invitations/{token}/activate",
        "/api/auth/invitations/{token}/verify",
        "/api/auth/login/oauth",
        "/api/auth/logout",
        "/api/auth/providers",
        "/api/auth/providers/link/start",
        "/api/auth/providers/{provider}",
        "/api/auth/refresh",
        "/api/auth/sessions",
        "/api/auth/sessions/{sessionId}",
        "/api/imports/students",
        "/api/imports/students/template",
        "/api/imports/students/upload",
        "/api/imports/students/{importId}",
        "/api/imports/students/{importId}/confirm",
        "/api/invitations",
        "/api/invitations/bulk",
        "/api/invitations/bulk/{bulkInviteId}",
        "/api/invitations/bulk/{bulkInviteId}/recipients",
        "/api/invitations/bulk/{bulkInviteId}/retry",
        "/api/invitations/{id}/regenerate",
        "/api/invitations/{id}/revoke",
        "/api/schools/current/settings",
        "/api/schools/register",
        "/api/schools/resend-verification",
        "/api/schools/verify-email/{token}",
        "/api/schools/{schoolId}/provision",
        "/api/schools/{schoolId}/provisioning-status",
        "/api/students",
        "/api/students/{studentId}",
        "/api/students/{studentId}/guardians",
        "/api/students/{studentId}/guardians/{userId}",
        "/api/subscriptions/checkout",
        "/api/subscriptions/plans",
        "/api/subscriptions/portal",
        "/api/subscriptions/webhook/stripe",
        "/api/teachers",

        "/api/approvals/bulk-decision",
        "/api/approvals/queue",
        "/api/teachers/me",
        "/api/teachers/{teacherId}",
        "/api/users",
        "/api/users/{userId}",
        "/api/users/{userId}/deactivate",
        "/api/users/{userId}/role",
        "/erpnext/webhooks",
        "/healthz",
        "/readyz",
      ].sort(),
    );
  });

  test("has at least one operation", () => {
    expect(operations.length).toBeGreaterThan(0);
  });
});

describe("every operation", () => {
  test("documents an application/problem+json error response", () => {
    for (const { path: p, method, operation } of operations) {
      const problems = Object.entries(operation.responses).filter(
        ([, response]) => response.content?.["application/problem+json"] !== undefined,
      );

      expect(
        problems.length,
        `${method.toUpperCase()} ${p} documents no problem+json response`,
      ).toBeGreaterThan(0);

      for (const [status, response] of problems) {
        expect(
          response.content?.["application/problem+json"]?.schema?.$ref,
          `${method.toUpperCase()} ${p} ${status} does not reference the shared ProblemDetails`,
        ).toBe("#/components/schemas/ProblemDetails");
      }
    }
  });

  // requestIdMiddleware stamps this unconditionally, after next(), including on responses built by
  // app.onError — so every declared response must say so.
  test("declares the X-Request-Id header on every response", () => {
    for (const { path: p, method, operation } of operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const header = response.headers?.["X-Request-Id"];

        expect(
          header,
          `${method.toUpperCase()} ${p} ${status} is missing X-Request-Id`,
        ).toBeDefined();
        expect(
          header!.required,
          `${method.toUpperCase()} ${p} ${status} X-Request-Id is optional`,
        ).toBe(true);
        expect(header!.schema?.format).toBe("uuid");
      }
    }
  });

  test("has an operationId", () => {
    for (const { path: p, method, operation } of operations) {
      expect(operation.operationId, `${method.toUpperCase()} ${p} has no operationId`).toBeTruthy();
    }
  });

  test("has a unique operationId", () => {
    const ids = operations.map(({ operation }) => operation.operationId);

    expect(ids.length).toBe(new Set(ids).size);
  });

  test("uses only tags the document declares", () => {
    const declared = new Set((document.tags ?? []).map((tag) => tag.name));

    for (const { path: p, method, operation } of operations) {
      for (const tag of operation.tags ?? []) {
        expect(declared.has(tag), `${method.toUpperCase()} ${p} uses undeclared tag "${tag}"`).toBe(
          true,
        );
      }
    }
  });

  // Documenting a failure the server has no code path to produce is as much a lie as omitting one it
  // does. PROBLEM_STATUSES is derived from errorHandlerMiddleware's own status maps.
  test("documents only problem statuses errorHandlerMiddleware can emit", () => {
    for (const { path: p, method, operation } of operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (response.content?.["application/problem+json"] === undefined) continue;

        expect(
          (PROBLEM_STATUSES as readonly number[]).includes(Number(status)),
          `${method.toUpperCase()} ${p} documents problem+json for un-emittable status ${status}`,
        ).toBe(true);
      }
    }
  });
});

describe("security", () => {
  test("declares the bearerAuth scheme", () => {
    expect(document.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  /**
   * Every operation states its own security, and none inherits a root-level default.
   *
   * This test used to assert the stronger claim that nothing authenticates at all, which was true
   * until ST-070 mounted jwtAuthMiddleware and ST-071 added the first routes behind it — so the
   * name it carried until now ("requires no authentication anywhere") had stopped describing what
   * it checks. What survives from that version, and is the part worth keeping, is the requirement
   * that every operation says so *explicitly*: a document that omits `security` is ambiguous between
   * "public" and "the author forgot", and the two are indistinguishable to a client generator.
   *
   * `document.security` stays undefined deliberately. A root-level requirement would claim the whole
   * API is authenticated, which is false — /healthz, /readyz, the JWKS endpoint, the webhook, and
   * the two refresh-token endpoints are all reachable without a bearer token — and a reader would
   * have to diff each operation's override against it to find out which.
   */
  test("states security explicitly on every operation, with no root-level default", () => {
    expect(document.security).toBeUndefined();

    for (const { path: p, method, operation } of operations) {
      const hasBearerAuth = (operation.security ?? []).some(
        (s) => typeof s === "object" && s !== null && "bearerAuth" in s,
      );
      if (hasBearerAuth) continue;

      expect(
        operation.security,
        `${method.toUpperCase()} ${p} does not state its security`,
      ).toBeDefined();
    }
  });

  /**
   * The authenticated set matches what jwtAuthMiddleware actually enforces.
   *
   * Pinned rather than derived, because the document and the middleware are two independent
   * statements of the same fact and the point is to catch them disagreeing. A route that gains
   * `security: [{ bearerAuth: [] }]` without being moved behind the boundary — or, far worse, one
   * dropped from DEFAULT_PUBLIC_PATHS while still documented as public — fails here.
   */
  test("marks exactly the routes behind the authentication boundary", () => {
    const authenticated = operations
      .filter(({ operation }) => (operation.security ?? []).length > 0)
      .map(({ method, path: p }) => `${method.toUpperCase()} ${p}`)
      .sort();

    expect(authenticated).toEqual(
      [
        // Device revocation (ST-072). The two /api/admin routes are authenticated *and* gated on
        // PERMISSIONS.USER_SUSPEND by middleware/authz.ts — a distinction this document cannot
        // express, since bearerAuth covers only the first half. See routes/admin-device-routes.ts.
        "DELETE /api/admin/users/{userId}/devices",
        "DELETE /api/admin/users/{userId}/devices/{deviceId}",
        "DELETE /api/admin/users/{userId}/providers/{provider}",
        "DELETE /api/academics/classes/{classId}",
        "DELETE /api/academics/classes/{classId}/enrollments/{studentId}",
        "DELETE /api/academics/assignments/{assignmentId}",
        "DELETE /api/academics/assignments/{assignmentId}/attachments/{attachmentId}",
        "DELETE /api/academics/submissions/{submissionId}/attachments/{attachmentId}",
        "DELETE /api/academics/courses/{courseId}",
        "DELETE /api/academics/exams/{examId}",
        "DELETE /api/academics/materials/{materialId}",
        "DELETE /api/academics/slots/{slotId}",
        "DELETE /api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
        "DELETE /api/academics/subjects/{subjectId}",
        "DELETE /api/academics/timetable-versions/{versionId}",
        "DELETE /api/academics/years/{yearId}",
        "DELETE /api/academics/terms/{termId}",
        "DELETE /api/auth/devices/{deviceId}",
        "DELETE /api/auth/devices/{deviceId}/sessions",
        "DELETE /api/auth/providers/{provider}",
        "DELETE /api/auth/sessions/{sessionId}",
        "DELETE /api/students/{studentId}/guardians/{userId}",
        "DELETE /api/evaluations/templates/{templateId}",
        "DELETE /api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
        "GET /api/discipline/incidents",
        "GET /api/discipline/incidents/{incidentId}",
        "GET /api/discipline/incidents/{incidentId}/actions",
        "GET /api/finance/fee-structures",
        "GET /api/finance/expenses",
        "GET /api/finance/expenses/summary",
        "GET /api/finance/expenses/{expenseId}",
        "GET /api/finance/scholarship-discounts",
        "GET /api/finance/scholarship-discounts/awards",
        "GET /api/academics/assignments",
        "GET /api/academics/assignments/{assignmentId}",
        "GET /api/academics/assignments/{assignmentId}/submissions",
        "GET /api/academics/submissions/{submissionId}",
        "GET /api/academics/classes",
        "GET /api/academics/classes/{classId}",
        "GET /api/academics/classes/{classId}/enrollments",
        "GET /api/academics/courses/{courseId}",
        "GET /api/academics/exams",
        "GET /api/academics/exams/{examId}",
        "GET /api/academics/materials",
        "GET /api/academics/materials/{materialId}",
        "GET /api/academics/slots/{slotId}",
        "GET /api/grades/config/gradebooks/{gradebookId}/categories",
        "GET /api/grades/config/gradebooks/{gradebookId}/scheme",
        "GET /api/grades/config/schemes",
        "GET /api/grades/config/schemes/{schemeId}",
        "GET /api/grades/gradebooks/{gradebookId}/entry",
        "GET /api/grades/published/students/{studentId}/terms/{termId}",
        "GET /api/academics/subjects",
        "GET /api/academics/subjects/{subjectId}",
        "GET /api/academics/subjects/{subjectId}/courses",
        "GET /api/academics/timetable-versions",
        "GET /api/academics/timetable-versions/{versionId}",
        "GET /api/academics/timetable-versions/{versionId}/slots",
        "GET /api/academics/years",
        "GET /api/academics/years/{yearId}",
        "GET /api/academics/years/{yearId}/terms",
        "GET /api/academics/terms/{termId}",
        "GET /api/attendance/records/{recordId}/history",
        "GET /api/attendance/reports/export/{jobId}",
        "GET /api/attendance/reports/summary",
        "GET /api/attendance/reports/trends",
        "GET /api/attendance/sessions",
        "GET /api/attendance/sessions/{sessionId}",
        "GET /api/auth/devices",
        "GET /api/evaluations",
        "GET /api/evaluations/{evaluationId}",
        "GET /api/evaluations/{evaluationId}/scores",
        "GET /api/evaluations/templates",
        "GET /api/evaluations/templates/{templateId}",
        "GET /api/approvals/queue",
        "GET /api/auth/providers",
        "GET /api/auth/sessions",
        "GET /api/imports/students",
        "GET /api/imports/students/template",
        "GET /api/imports/students/{importId}",
        "GET /api/invitations/bulk",
        "GET /api/invitations/bulk/{bulkInviteId}",
        "GET /api/invitations/bulk/{bulkInviteId}/recipients",
        "GET /api/schools/current/settings",
        "PATCH /api/schools/current/settings",
        "GET /api/students",
        "GET /api/students/{studentId}",
        "GET /api/students/{studentId}/guardians",
        "GET /api/subscriptions/plans",
        "GET /api/teachers",
        "GET /api/teachers/me",
        "GET /api/teachers/{teacherId}",
        "GET /api/users",
        "GET /api/users/{userId}",
        "GET /api/schools/{schoolId}/provisioning-status",
        "PATCH /api/academics/assignments/{assignmentId}",
        "PATCH /api/academics/classes/{classId}",
        "PATCH /api/academics/courses/{courseId}",
        "PATCH /api/academics/exams/{examId}",
        "PATCH /api/academics/materials/{materialId}",
        "PATCH /api/academics/materials/{materialId}/ai-visible",
        "PATCH /api/academics/slots/{slotId}",
        "PATCH /api/attendance/records/{recordId}",
        "PATCH /api/attendance/sessions/{sessionId}",
        "PATCH /api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
        "PATCH /api/grades/gradebooks/{gradebookId}/grades",
        "PATCH /api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/decide",
        "PATCH /api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/submit",
        "PATCH /api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/unlock",
        "PATCH /api/academics/subjects/{subjectId}",
        "PATCH /api/academics/timetable-versions/{versionId}",
        "PATCH /api/academics/years/{yearId}",
        "PATCH /api/academics/terms/{termId}",
        "PATCH /api/academics/submissions/{submissionId}/grade",
        "PATCH /api/evaluations/templates/{templateId}",
        "PATCH /api/evaluations/{evaluationId}",
        "PATCH /api/discipline/incidents/{incidentId}",
        "PATCH /api/discipline/incidents/{incidentId}/actions/{actionId}",
        "PATCH /api/finance/fee-structures/{feeStructureId}",
        "PATCH /api/finance/expenses/{expenseId}",
        "PATCH /api/students/{studentId}",
        "PATCH /api/teachers/{teacherId}",
        "PATCH /api/users/{userId}",
        "PATCH /api/users/{userId}/deactivate",
        "PATCH /api/users/{userId}/role",
        "POST /api/academics/assignments",
        "POST /api/academics/assignments/{assignmentId}/attachments",
        "POST /api/academics/assignments/{assignmentId}/attachments/upload-url",
        "POST /api/academics/assignments/{assignmentId}/submissions",
        "POST /api/academics/submissions/{submissionId}/attachments",
        "POST /api/academics/submissions/{submissionId}/attachments/upload-url",
        "POST /api/academics/classes",
        "POST /api/academics/classes/{classId}/enrollments",
        "POST /api/academics/classes/{classId}/enrollments/transfer",
        "POST /api/academics/exams",
        "POST /api/academics/materials/{materialId}/confirm",
        "POST /api/academics/materials/upload",
        "POST /api/academics/subjects",
        "POST /api/grades/config/gradebooks/{gradebookId}/categories",
        "POST /api/grades/config/gradebooks/{gradebookId}/scheme/link",
        "POST /api/grades/config/schemes",
        "POST /api/academics/subjects/{subjectId}/courses",
        "POST /api/academics/timetable-versions",
        "POST /api/academics/timetable-versions/{versionId}/approve",
        "POST /api/academics/timetable-versions/{versionId}/reject",
        "POST /api/academics/timetable-versions/{versionId}/slots",
        "POST /api/academics/timetable-versions/{versionId}/submit",
        "POST /api/academics/timetable-versions/copy",
        "POST /api/academics/years",
        "POST /api/academics/years/{yearId}/rollover",
        "POST /api/academics/years/{yearId}/terms",
        "POST /api/admin/subscriptions/sync-prices",
        "POST /api/attendance/records/batch",
        "POST /api/attendance/reports/export",
        "POST /api/attendance/sessions",
        "POST /api/discipline/incidents",
        "POST /api/evaluations",
        "POST /api/evaluations/templates",
        "POST /api/evaluations/{evaluationId}/share",
        "POST /api/evaluations/{evaluationId}/submit",
        "POST /api/approvals/bulk-decision",
        "POST /api/discipline/incidents/{incidentId}/actions",
        "POST /api/discipline/incidents/{incidentId}/resolve",
        "POST /api/finance/fee-structures",
        "POST /api/finance/expenses",
        "POST /api/finance/expenses/upload-url",
        "POST /api/finance/expenses/{expenseId}/attachments",
        "POST /api/finance/scholarship-discounts/awards",
        "POST /api/finance/scholarship-discounts/awards/{awardId}/confirm",
        "POST /api/auth/providers/link/start",
        "POST /api/imports/students/upload",
        "POST /api/imports/students/{importId}/confirm",
        "POST /api/invitations/bulk",
        "POST /api/invitations/bulk/{bulkInviteId}/retry",
        "POST /api/invitations",
        "POST /api/invitations/{id}/regenerate",
        "POST /api/invitations/{id}/revoke",
        "POST /api/students",
        "POST /api/students/{studentId}/guardians",
        "POST /api/subscriptions/checkout",
        "POST /api/subscriptions/portal",
        "POST /api/teachers",
        "POST /api/users",
        "PUT /api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
        "POST /api/schools/{schoolId}/provision",
      ].sort(),
    );
  });
});

describe("the generated artifact", () => {
  // The generated file is gitignored and regenerated in CI. This test writes it if absent (e.g.
  // a fresh checkout) and verifies it matches the current routes.
  test("matches what the routes currently generate", async () => {
    const file = Bun.file(COMMITTED_SPEC);
    const exists = await file.exists();

    if (!exists) {
      await writeFile(COMMITTED_SPEC, `${JSON.stringify(document, null, 2)}\n`);
    }

    const committed = (await file.json()) as Record<string, unknown>;
    const { [BANNER_KEY]: banner, ...spec } = committed;

    expect(banner, "the generator's do-not-edit banner is missing").toBeString();
    expect(spec, "apps/api/openapi.json is stale — run `bun run openapi:generate`").toEqual(
      serialized,
    );
  });

  test("is what the server serves at /openapi.json", async () => {
    const keyStore = new KeyStore(60_000);
    await keyStore.init();
    const app = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      redis: null,
      database: createUnusableDatabase(),
      keyStore,
      docsEnabled: true,
    });

    const res = await app.request("/openapi.json");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(serialized);
    keyStore.destroy();
  });
});

describe("the reference site", () => {
  const build = (docsEnabled: boolean) =>
    createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      redis: null,
      database: createUnusableDatabase(),
      docsEnabled,
    });

  test("is served when enabled", async () => {
    const res = await build(true).request("/docs");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  // Production passes docsEnabled: false. Scalar's page loads its bundle from a CDN, and the 404
  // here is what keeps production from depending on a third party to render a page it does not need.
  test("is absent when disabled, and 404s through the problem+json handler", async () => {
    const res = await build(false).request("/docs");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });

  test("does not serve the document when disabled", async () => {
    expect((await build(false).request("/openapi.json")).status).toBe(404);
  });
});
