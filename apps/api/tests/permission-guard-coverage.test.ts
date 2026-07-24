/**
 * CI gate: every mutating route that acts on another user's data must carry a
 * requirePermission() guard.
 *
 * Mirrors the structure of audit-coverage.test.ts: scan source files for mutating
 * route registrations, verify each is accompanied by a requirePermission() call in
 * the same file, and pin the expected count so a blind scanner fails loudly.
 *
 * Self-service routes (session lifecycle) and webhook routes (HMAC-authenticated)
 * are exempt — they either operate on the caller's own data or authenticate by
 * other means. The exemption list is explicit and enumerable.
 *
 * ## Why per-file, not per-route
 *
 * `requirePermission` is mounted as `routes.use(path, guard)` before the route
 * handler is registered, so it lives in the same file but on a different line.
 * A 15-line proximity window (like audit-coverage) would work, but per-file is
 * simpler and equally correct because Hono route files are small and focused —
 * a single file never mixes guarded and unguarded admin routes.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

const SRC_DIR = resolve(import.meta.dir, "../src");
const EXCLUDE_PATTERNS = [/\.test\.ts$/, /\.d\.ts$/, /__tests__/];
const MUTATING_METHODS = ["post", "put", "patch", "delete"] as const;

/**
 * Every mutating route that currently exists, by "METHOD path".
 *
 * Kept in sync with audit-coverage.test.ts's list. A new mutating route must be
 * added here and to audit-coverage.test.ts simultaneously.
 */
const EXPECTED_MUTATING_ROUTES = [
  "POST /api/invitations",
  "POST /api/invitations/{id}/revoke",
  "POST /api/invitations/{id}/regenerate",
  "POST /api/auth/invitations/{token}/activate",
  "POST /api/auth/login/oauth",
  "POST /api/auth/providers/link/start",
  "POST /api/schools/register",
  "POST /erpnext/webhooks",
  "POST /api/auth/refresh",
  "POST /api/auth/logout",
  "DELETE /api/auth/sessions/{sessionId}",
  "DELETE /api/auth/devices/{deviceId}/sessions",
  "DELETE /api/auth/devices/{deviceId}",
  "DELETE /api/auth/providers/{provider}",
  "DELETE /api/admin/users/{userId}/devices",
  "DELETE /api/admin/users/{userId}/devices/{deviceId}",
  "DELETE /api/admin/users/{userId}/providers/{provider}",
  // School email verification (ST-088). Self-service; authorized by the caller's school identity.
  "POST /api/schools/resend-verification",
  // School settings (ST-090). Gated on ORGANIZATION_MANAGE_SETTINGS.
  "PATCH /api/schools/current/settings",
  // Tenant provisioning (ST-089). School admin triggers provisioning for their own school;
  // school context is sufficient — no cross-user row-level permission.
  "POST /api/schools/{schoolId}/provision",
  // Academic year & term management (ST-091). Tenant-scoped CRUD protected by requireAuth; the
  // school context is sufficient — there is no cross-user row-level permission to check.
  "POST /api/academics/years",
  "PATCH /api/academics/years/{yearId}",
  "DELETE /api/academics/years/{yearId}",
  "POST /api/academics/years/{yearId}/rollover",
  "POST /api/academics/years/{yearId}/terms",
  "PATCH /api/academics/terms/{termId}",
  "DELETE /api/academics/terms/{termId}",
  // User management & administration (ST-093). Authenticated, tenant-scoped CRUD with per-route
  // requirePermission() guards for USER_READ, USER_CREATE, USER_UPDATE, ROLE_ASSIGN, and USER_SUSPEND.
  "POST /api/users",
  "PATCH /api/users/{userId}",
  "PATCH /api/users/{userId}/role",
  "PATCH /api/users/{userId}/deactivate",
];

/**
 * Mutating routes exempt from the requirePermission() guard.
 *
 * Self-service routes operate on the caller's own data — the caller's identity
 * (established by jwtAuth.ts) is sufficient authorization; there is no
 * "someone else's row" to protect. Webhook routes authenticate by HMAC signature,
 * not by bearer token, and are structurally outside the permission model.
 *
 * Invitation routes predate the permission guard and use inline role checks
 * instead of requirePermission(). They carry equivalent authorization but not
 * through the standardised middleware. They are exempt until migrated.
 */
const GUARD_EXEMPT_ROUTES = new Set([
  // Session lifecycle — caller's own data.
  "POST /api/auth/refresh",
  "POST /api/auth/logout",
  "DELETE /api/auth/sessions/{sessionId}",
  "DELETE /api/auth/devices/{deviceId}/sessions",
  "DELETE /api/auth/devices/{deviceId}",
  // Webhook — HMAC-authenticated, not bearer.
  "POST /erpnext/webhooks",
  // Account activation (ST-078) — public self-service onboarding. Authorized by the invitation
  // token in the path plus a verified Microsoft OIDC identity, not by a bearer permission; there is
  // no other user's data to protect.
  "POST /api/auth/invitations/{token}/activate",
  // Returning-user OAuth login (ST-079) — public self-service login. Authorized by a verified
  // Microsoft OIDC id_token, not by a bearer permission; authenticates the caller, not another user.
  "POST /api/auth/login/oauth",
  // Provider linking (ST-080) — self-service link/unlink on the caller's own data.
  "POST /api/auth/providers/link/start",
  "DELETE /api/auth/providers/{provider}",
  // School self-registration (ST-081) — public unauthenticated endpoint; no caller identity or
  // bearer permission; authorized by Turnstile captcha only.
  "POST /api/schools/register",
  // School email verification (ST-088) — self-service resend for the caller's own school.
  // School email verification (ST-088) — public self-service endpoint; authorized by a one-time
  // verification token, not by a bearer permission; no other user's data to protect.
  "POST /api/schools/resend-verification",
  // Tenant provisioning (ST-089) — school admin self-service on their own school's provisioning.
  "POST /api/schools/{schoolId}/provision",
  // Pre-ST-072 inline role checks — migrate to requirePermission and remove.
  "POST /api/invitations",
  "POST /api/invitations/{id}/revoke",
  "POST /api/invitations/{id}/regenerate",
  // Academic year & term management (ST-091) — tenant-scoped school-level access protected by
  // requireAuth; no cross-user row-level permission to check.
  "POST /api/academics/years",
  "PATCH /api/academics/years/{yearId}",
  "DELETE /api/academics/years/{yearId}",
  "POST /api/academics/years/{yearId}/rollover",
  "POST /api/academics/years/{yearId}/terms",
  "PATCH /api/academics/terms/{termId}",
  "DELETE /api/academics/terms/{termId}",
]);

// ---------------------------------------------------------------------------
// File scanning (same pattern as audit-coverage.test.ts)
// ---------------------------------------------------------------------------

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
  hasRequirePermission: boolean;
}

function hasRequirePermissionInFile(source: string): boolean {
  return /\brequirePermission\s*\(/.test(source);
}

function findMutatingRoutes(files: string[]): MutatingRoute[] {
  const routes: MutatingRoute[] = [];
  const methods = MUTATING_METHODS.join("|");

  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from our own src tree
    const lines = stripComments(readFileSync(file, "utf-8"));
    const relFile = relative(SRC_DIR, file);
    const source = lines.join("\n");
    const guarded = hasRequirePermissionInFile(source);

    const record = (line: number, method: string, path: string) => {
      routes.push({
        file: relFile,
        line,
        method: method.toUpperCase(),
        path,
        hasRequirePermission: guarded,
      });
    };

    // Style 1: plain Hono — routes.post("/path", ...)
    const directPattern = new RegExp(
      "routes\\.(" + methods + ")\\s*\\(\\s*[\"'`](/[^\"'`]+)[\"'`]",
      "g",
    );
    for (let i = 0; i < lines.length; i++) {
      directPattern.lastIndex = 0;
      const match = directPattern.exec(lines[i]!);
      if (match) record(i + 1, match[1]!, match[2]!);
    }

    // Style 2: @hono/zod-openapi — createRoute({ method: "post", path: "/path", ... }).
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("permission guard route coverage", () => {
  test("every mutating route is accounted for in the expected list", () => {
    const files = collectSourceFiles(SRC_DIR);
    const routes = findMutatingRoutes(files);

    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [...EXPECTED_MUTATING_ROUTES].sort(),
    );
  });

  test("every non-exempt mutating route has requirePermission in its file", () => {
    const files = collectSourceFiles(SRC_DIR);
    const routes = findMutatingRoutes(files);

    const unguarded = routes.filter(
      (r) => !GUARD_EXEMPT_ROUTES.has(`${r.method} ${r.path}`) && !r.hasRequirePermission,
    );

    if (unguarded.length > 0) {
      const detail = unguarded
        .map((r) => `  ${r.file}:${r.line}  ${r.method} ${r.path}`)
        .join("\n");
      throw new Error(
        `Mutating routes without requirePermission():\n${detail}\n\n` +
          "Every mutating route that acts on another user's data must use requirePermission(). " +
          "Self-service and webhook routes are exempt — add them to GUARD_EXEMPT_ROUTES.",
      );
    }

    expect(unguarded).toHaveLength(0);
  });

  test("does not mistake doc-comment examples for routes", () => {
    const routes = findMutatingRoutes(collectSourceFiles(SRC_DIR));

    expect(
      routes.filter((r) => r.file.includes("authz") || r.file.includes("auditEmitter")),
    ).toEqual([]);
  });
});
