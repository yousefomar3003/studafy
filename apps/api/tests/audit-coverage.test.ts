/**
 * CI gate: every mutating route must declare an audit action.
 *
 * This test scans source files under src/ for mutating route registrations and verifies each is
 * accompanied by an auditAction() call. A missing declaration means an un-audited mutation could
 * ship to production, which violates SAD section 15.
 *
 * Health endpoints are excluded -- they are GET-only and carry no mutation.
 *
 * ## Two registration styles, both scanned (ST-060)
 *
 * 1. `routes.post("/path", auditAction(...), handler)` -- plain Hono; verb and path are arguments.
 * 2. `createRoute({ method: "post", path: "/path" })` + `routes.openapi(route, handler)` --
 *    @hono/zod-openapi, where the verb and path live in a config object and middleware is attached
 *    separately with `routes.use("/path", auditAction(...))`.
 *
 * Style 2 is why this scanner cannot only look for `routes.post(`. When the ERPNext webhook moved to
 * style 1 -> 2, a `routes.post(`-only scan stopped seeing the codebase's only real mutating route,
 * and still passed -- because its two "matches" were the @example lines in auditEmitter.ts's own
 * doc comment. The gate was green while protecting nothing. Hence: comments are stripped before
 * scanning, and EXPECTED_MUTATING_ROUTES below pins the count so a scanner that goes blind fails
 * instead of passing quietly.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

const SRC_DIR = resolve(import.meta.dir, "../src");

// Files matching these patterns are excluded from the scan.
const EXCLUDE_PATTERNS = [/\.test\.ts$/, /\.d\.ts$/, /__tests__/];

// Mutating HTTP methods that require audit coverage.
const MUTATING_METHODS = ["post", "put", "patch", "delete"] as const;

// Patterns that explicitly exempt a route from audit coverage (e.g. health endpoints).
const EXEMPT_ROUTES = ["/healthz", "/readyz"];

/**
 * Every mutating route that currently exists, by "METHOD path".
 *
 * A pinned list, not a lower bound. `expect(routes.length).toBeGreaterThan(0)` cannot tell "the
 * scanner works" from "the scanner matched a code sample in a comment", which is exactly how this
 * gate silently stopped covering the webhook. Adding a mutating route means adding it here, and the
 * failure names what to do.
 */
const EXPECTED_MUTATING_ROUTES = [
  "POST /api/invitations",
  "POST /api/invitations/{id}/revoke",
  "POST /api/invitations/{id}/regenerate",
  // School self-registration (ST-081). Public unauthenticated endpoint; audit rows are written
  // from inside the service transaction.
  "POST /api/schools/register",
  // Account activation (ST-078). Consumes the invitation and activates the user in one transaction;
  // the audit rows are written from inside that transaction — see
  // src/modules/auth/services/activation-service.ts.
  "POST /api/auth/invitations/{token}/activate",
  // Returning-user OAuth login (ST-079). Public self-service login via Microsoft OIDC id_token.
  // Audit rows are written from the route's service transaction.
  "POST /api/auth/login/oauth",
  "POST /erpnext/webhooks",
  // Session lifecycle (ST-071). All four mutate app.refresh_tokens. The revocation paths write
  // their audit rows from inside the service transaction rather than from the route, so that a
  // revocation and its audit record commit or roll back together — see
  // src/modules/auth/services/session-service.ts.
  "POST /api/auth/refresh",
  "POST /api/auth/logout",
  "DELETE /api/auth/sessions/{sessionId}",
  "DELETE /api/auth/devices/{deviceId}/sessions",
  // Device revocation (ST-072). Same contract as the ST-071 routes above: the audit row is written
  // from inside the revoking transaction in services/revocation-service.ts, so a teardown and its
  // record commit or roll back together. The two admin paths act on a user other than the caller and
  // are additionally gated on PERMISSIONS.USER_SUSPEND by middleware/authz.ts.
  "DELETE /api/auth/devices/{deviceId}",
  "DELETE /api/admin/users/{userId}/devices",
  "DELETE /api/admin/users/{userId}/devices/{deviceId}",
  // Provider linking (R-03). Link start creates an oauth_identities row; unlink and admin unlink
  // delete one. Audit rows are written from inside the service transactions.
  "POST /api/auth/providers/link/start",
  "DELETE /api/auth/providers/{provider}",
  "DELETE /api/admin/users/{userId}/providers/{provider}",
  // School email verification (ST-088). Resends the verification email for a pending school.
  "POST /api/schools/resend-verification",
  // School settings (ST-090). PATCH updates school_settings with full before/after audit.
  "PATCH /api/schools/current/settings",
  // Tenant provisioning (ST-089). School admin triggers provisioning for their own school;
  // audit rows are written by the auditAction middleware on the route.
  "POST /api/schools/{schoolId}/provision",
  // Academic year & term management (ST-091). Authenticated, tenant-scoped CRUD and rollover.
  "POST /api/academics/years",
  "PATCH /api/academics/years/{yearId}",
  "DELETE /api/academics/years/{yearId}",
  "POST /api/academics/years/{yearId}/rollover",
  "POST /api/academics/years/{yearId}/terms",
  "PATCH /api/academics/terms/{termId}",
  "DELETE /api/academics/terms/{termId}",
  // Subjects & courses (ST-099). Tenant-scoped CRUD protected by requireAuth; school-level
  // catalog data with no cross-user row-level permission.
  "POST /api/academics/subjects",
  "PATCH /api/academics/subjects/{subjectId}",
  "DELETE /api/academics/subjects/{subjectId}",
  "POST /api/academics/subjects/{subjectId}/courses",
  "PATCH /api/academics/courses/{courseId}",
  "DELETE /api/academics/courses/{courseId}",
  // User management & administration (ST-093). Authenticated, tenant-scoped CRUD and deactivation.
  "POST /api/users",
  "PATCH /api/users/{userId}",
  "PATCH /api/users/{userId}/role",
  "PATCH /api/users/{userId}/deactivate",
  // Student profiles. Authenticated, tenant-scoped CRUD with per-route requirePermission() guards.
  // Audit rows are written from inside the service transactions.
  "POST /api/students",
  "PATCH /api/students/{studentId}",
  // Student guardians. Link/unlink parent-child relationships with audit trails.
  "POST /api/students/{studentId}/guardians",
  "DELETE /api/students/{studentId}/guardians/{userId}",
  // Teacher profiles. Authenticated, tenant-scoped CRUD with per-route requirePermission() guards.
  // Audit rows are written from inside the service transactions.
  "POST /api/teachers",
  "PATCH /api/teachers/{teacherId}",
  // Student CSV imports. Upload and confirm are mutating; audit rows written from the route.
  "POST /api/imports/students/upload",
  "POST /api/imports/students/{importId}/confirm",
  // Bulk invitations. Admin dispatches invitations in batches; audit rows written by
  // auditAction middleware in bulk-invite-routes.ts.
  "POST /api/invitations/bulk",
  "POST /api/invitations/bulk/{bulkInviteId}/retry",
  // Classes & enrollments (ST-100). Tenant-scoped CRUD protected by requireAuth; school-level
  // catalog data with no cross-user row-level permission.
  "POST /api/academics/classes",
  "PATCH /api/academics/classes/{classId}",
  "DELETE /api/academics/classes/{classId}",
  "POST /api/academics/classes/{classId}/enrollments",
  "DELETE /api/academics/classes/{classId}/enrollments/{studentId}",
  "POST /api/academics/classes/{classId}/enrollments/transfer",
  // Timetable (ST-101). Version lifecycle + slot CRUD with conflict detection.
  "POST /api/academics/timetable-versions",
  "PATCH /api/academics/timetable-versions/{versionId}",
  "DELETE /api/academics/timetable-versions/{versionId}",
  "POST /api/academics/timetable-versions/{versionId}/submit",
  "POST /api/academics/timetable-versions/{versionId}/approve",
  "POST /api/academics/timetable-versions/{versionId}/reject",
  "POST /api/academics/timetable-versions/copy",
  "POST /api/academics/timetable-versions/{versionId}/slots",
  "PATCH /api/academics/slots/{slotId}",
  "DELETE /api/academics/slots/{slotId}",
  // Assignments (ST-103). Every mutation writes an app.audit_logs row from inside its own service
  // transaction — see modules/academics/assignments/assignment-service.ts and attachment-service.ts.
  "POST /api/academics/assignments",
  "PATCH /api/academics/assignments/{assignmentId}",
  "DELETE /api/academics/assignments/{assignmentId}",
  "POST /api/academics/assignments/{assignmentId}/attachments/upload-url",
  "POST /api/academics/assignments/{assignmentId}/attachments",
  "DELETE /api/academics/assignments/{assignmentId}/attachments/{attachmentId}",
  // Submissions (ST-104). Same contract as the assignments routes above: every mutation writes its
  // app.audit_logs row from inside its own service transaction, so a hand-in, a grade change or a
  // superseded attempt and its record commit or roll back together — see
  // modules/academics/submissions/submission-service.ts and submission-attachment-service.ts. The
  // POST is declared "insert" although a resubmission updates in place; the service emits the
  // action that actually occurred.
  "POST /api/academics/assignments/{assignmentId}/submissions",
  "PATCH /api/academics/submissions/{submissionId}/grade",
  "POST /api/academics/submissions/{submissionId}/attachments/upload-url",
  "POST /api/academics/submissions/{submissionId}/attachments",
  "DELETE /api/academics/submissions/{submissionId}/attachments/{attachmentId}",
  // Exam scheduling (ST-102). Tenant-scoped CRUD protected by requireAuth; school-level
  // catalog data with no cross-user row-level permission. Audit rows written by auditAction middleware.
  "POST /api/academics/exams",
  "PATCH /api/academics/exams/{examId}",
  "DELETE /api/academics/exams/{examId}",
  // Attendance sessions. Tenant-scoped session management protected by requireAuth; school-level
  // data with no cross-user row-level permission. Audit rows written by auditAction middleware.
  "POST /api/attendance/records/batch",
  "POST /api/attendance/sessions",
  "PATCH /api/attendance/sessions/{sessionId}",
  // Learning materials (ST-102). Teacher upload/manage with metadata, pre-signed upload flow,
  // and AI visibility toggle with chunk purge.
  "POST /api/academics/materials/upload",
  "POST /api/academics/materials/{materialId}/confirm",
  "PATCH /api/academics/materials/{materialId}",
  "DELETE /api/academics/materials/{materialId}",
  "PATCH /api/academics/materials/{materialId}/ai-visible",
];

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a readdir of our own src tree
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.endsWith(".ts") && !EXCLUDE_PATTERNS.some((p) => p.test(entry))) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Blank out comments, preserving line numbers so reported positions stay accurate.
 *
 * Without this the scanner reads documentation as code: auditEmitter.ts's own doc block contains
 * `routes.post("/students", auditAction("insert", "students"), handler);` as an @example, which a
 * naive scan counts as a covered mutating route in a file that registers no routes at all.
 */
function stripComments(source: string): string[] {
  let inBlockComment = false;

  return source.split("\n").map((line) => {
    const trimmed = line.trim();

    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return "";
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      return "";
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return "";

    return line;
  });
}

interface MutatingRoute {
  file: string;
  line: number;
  method: string;
  path: string;
  hasAuditAction: boolean;
}

/**
 * True when auditAction() is declared for `path` in this file.
 *
 * Both styles put the two on one line -- `routes.post(path, auditAction(...), handler)` and
 * `routes.use(path, auditAction(...))` -- but a 15-line window around any mention of the path keeps
 * this working if a declaration is wrapped across lines. Anchoring on the path rather than on
 * proximity alone is what stops one audited route from vouching for an unaudited neighbour.
 */
function hasAuditActionForPath(lines: readonly string[], path: string): boolean {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(`"${path}"`)) continue;

    const window = lines.slice(Math.max(0, i - 15), Math.min(lines.length, i + 16)).join("\n");
    if (/\bauditAction\s*\(/.test(window)) return true;
  }

  return false;
}

function findMutatingRoutes(files: string[]): MutatingRoute[] {
  const routes: MutatingRoute[] = [];
  const methods = MUTATING_METHODS.join("|");

  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from our own src tree
    const lines = stripComments(readFileSync(file, "utf-8"));
    const relFile = relative(SRC_DIR, file);
    const source = lines.join("\n");

    const record = (line: number, method: string, path: string) => {
      if (EXEMPT_ROUTES.includes(path)) return;
      routes.push({
        file: relFile,
        line,
        method: method.toUpperCase(),
        path,
        hasAuditAction: hasAuditActionForPath(lines, path),
      });
    };

    // Style 1: plain Hono -- routes.post("/path", ...)
    const directPattern = new RegExp(
      "routes\\.(" + methods + ")\\s*\\(\\s*[\"'`](/[^\"'`]+)[\"'`]",
      "g",
    );
    for (let i = 0; i < lines.length; i++) {
      directPattern.lastIndex = 0;
      const match = directPattern.exec(lines[i]!);
      if (match) record(i + 1, match[1]!, match[2]!);
    }

    // Style 2: @hono/zod-openapi -- createRoute({ method: "post", path: "/path", ... }).
    // Only routes actually registered with routes.openapi() count; a createRoute config that is
    // never mounted serves no traffic and so audits nothing.
    if (/routes\.openapi\s*\(/.test(source)) {
      const createRoutePattern = /createRoute\s*\(\s*\{([\s\S]*?)\n\}\s*\)/g;
      let block: RegExpExecArray | null;

      while ((block = createRoutePattern.exec(source)) !== null) {
        const body = block[1]!;
        const method = new RegExp(`method:\\s*["'\`](${methods})["'\`]`).exec(body);
        const path = /path:\s*["'`](\/[^"'`]*)["'`]/.exec(body);
        if (!method || !path) continue;

        record(source.slice(0, block.index).split("\n").length, method[1]!, path[1]!);
      }
    }
  }

  return routes;
}

describe("audit route coverage", () => {
  test("every mutating route has a declared audit action", () => {
    const files = collectSourceFiles(SRC_DIR);
    const routes = findMutatingRoutes(files);

    const uncovered = routes.filter((r) => !r.hasAuditAction);

    if (uncovered.length > 0) {
      const detail = uncovered
        .map((r) => `  ${r.file}:${r.line}  ${r.method} ${r.path}`)
        .join("\n");
      throw new Error(
        `Mutating routes without auditAction():\n${detail}\n\n` +
          "Every mutating route must declare auditAction(action, table) as middleware.\n" +
          "See apps/api/src/middleware/auditEmitter.ts for the decorator API.",
      );
    }

    expect(uncovered).toHaveLength(0);
  });

  // The guard that actually guards. A scanner blinded by a refactor reports zero routes; a pinned
  // list turns that into a failure, where "greater than 0" would let a comment's code sample pass
  // for coverage of a route nobody is scanning any more.
  test("sees exactly the mutating routes that exist", () => {
    const files = collectSourceFiles(SRC_DIR);
    const routes = findMutatingRoutes(files);

    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [...EXPECTED_MUTATING_ROUTES].sort(),
    );
  });

  // Proves the scanner reads code rather than documentation. auditEmitter.ts registers no routes; it
  // only describes how to. Before ST-060 it was the only file this gate "found" anything in.
  test("does not mistake doc-comment examples for routes", () => {
    const routes = findMutatingRoutes(collectSourceFiles(SRC_DIR));

    expect(routes.filter((r) => r.file.includes("auditEmitter"))).toEqual([]);
  });
});
