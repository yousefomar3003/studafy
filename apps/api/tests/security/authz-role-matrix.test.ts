/**
 * ST-249: live authz matrix fuzzing (every role x every route).
 *
 * Two tiers, deliberately different in how they get their expectations, because a route inventory
 * this large has two different kinds of question and only one of them is safe to automate blindly:
 *
 * Tier A — crash/leak fuzz, generated from openapi.json, covers every operation (296 method+path
 * pairs across 226 routes as of this writing). For each one, every role gets a real HTTP request
 * through the real app + a real Postgres. The only claims are "never 500" and "every 4xx is a
 * well-formed problem+json envelope" (errorHandler.ts's own stated contract: 5xx never leaks
 * internals). This is honestly 100% route coverage for the crash/info-leak class of bug, and
 * nothing more — it does not know what any given route's *correct* answer for a given role is.
 *
 * Tier B — authorization-bypass fuzz for every `requirePermission()` mount point in src/, hand
 * -transcribed from the source (not regex-parsed at runtime: a parser subtly wrong about which
 * permission gates which path would be a worse outcome than no test at all — a false sense of
 * coverage). For each one, GUEST — who holds neither permission ever checked below, see
 * `packages/constants/src/permissions.ts` — must be denied, and ORG_ADMIN — who holds every
 * permission used below — must not be denied by that gate. This exercises the real enforcement
 * path end to end, catching what permission-guard-coverage.test.ts's static text-presence check
 * cannot: a guard that's present in the file but wired to the wrong path, or never actually mounted.
 *
 * Both tiers mint every token on the "web" channel, so a 403 unambiguously means the permission
 * guard fired, not the separate channel guard (see channel-guard.test.ts) that some admin routes
 * also carry.
 */

// Imported before src/middleware — see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROLES, ROLE_PERMISSIONS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { apiProblemSchema } from "../../src/middleware";
import { KeyStore } from "../../src/modules/auth";
import {
  assignRole,
  createFullTenant,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";

import type { AppEnv } from "../../src/middleware";
import type { TenantFixture, TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Permission, Role } from "@studafy/constants";
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | undefined;
let sql: Sql;
let tenant: TenantFixture;
let financeUserId: string;
let app: OpenAPIHono<AppEnv>;
let keyStore: KeyStore;

beforeAll(async () => {
  if (!integrationEnabled) return;

  // maxConnections matches Tier A's concurrency below: fewer connections than in-flight requests
  // means requests queue for a pooled connection, and this pool queueing (not any app bug) was
  // observed to occasionally surface as a transient error on an unrelated route under the full
  // 296-operation sweep. Keeping the two numbers equal removes that queueing pressure.
  database = await createTestDatabase({ maxConnections: 24 });
  await migrateDatabase(database.url);
  sql = database.sql;
  tenant = await createFullTenant(sql);

  // createFullTenant seeds the 8 roles it exercises elsewhere; FINANCE (ST-092, added after that
  // fixture was written) is seeded here rather than widening a shared factory every other test
  // file also depends on.
  const financeUser = await createUser(sql, tenant.schoolId, {
    email: `finance@test-${tenant.schoolSlug}.local`,
    displayName: "FINANCE User",
  });
  await assignRole(sql, tenant.schoolId, financeUser.id, ROLES.FINANCE);
  financeUserId = financeUser.id;

  // Tier A hits every route including the three webhook endpoints; without these two vars they'd
  // each hit their own "not configured" 500 before ever reaching signature verification, which
  // masks the thing actually worth fuzzing (does an unsigned/wrong-signature request get a clean
  // 401, not a crash) behind a config gap that's specific to this harness, not to production.
  process.env.ERPNEXT_WEBHOOK_SECRET ??= "test-erpnext-webhook-secret";
  process.env.EMAIL_EVENTS_SNS_TOPIC_ARN ??= "arn:aws:sns:us-east-1:000000000000:test-topic";

  keyStore = new KeyStore(60_000);
  await keyStore.init();

  resetSecurityConfig();
  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    database: sql,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
  });
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

const ALL_ROLES: Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.ORG_ADMIN,
  ROLES.FINANCE,
  ROLES.INSTRUCTOR,
  ROLES.TEACHING_ASSISTANT,
  ROLES.STUDENT,
  ROLES.PARENT,
  ROLES.GUEST,
  ROLES.SUPPORT_AGENT,
];

function userIdFor(role: Role): string {
  return role === ROLES.FINANCE ? financeUserId : tenant.users[role].id;
}

async function tokenFor(role: Role): Promise<string> {
  return mintTestToken(keyStore, {
    schoolId: tenant.schoolId,
    userId: userIdFor(role),
    roles: [role],
    channel: "web",
  });
}

// A fixed, syntactically valid uuid substituted for every path param whose value doesn't matter to
// the question being asked (neither tier needs the referenced row to exist).
const PLACEHOLDER_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const PARAM_OVERRIDES: Record<string, string> = {
  provider: "google",
  token: "placeholder-token",
  contentClass: "material",
};

function resolvePath(pathTemplate: string): string {
  return pathTemplate.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    Object.prototype.hasOwnProperty.call(PARAM_OVERRIDES, name)
      ? PARAM_OVERRIDES[name]!
      : PLACEHOLDER_UUID,
  );
}

async function requestAs(role: Role, method: string, pathTemplate: string): Promise<Response> {
  const token = await tokenFor(role);
  const init: RequestInit & { headers: Record<string, string> } = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    init.headers["Content-Type"] = "application/json";
    init.body = "{}";
  }
  return app.request(resolvePath(pathTemplate), init);
}

/** Run a batch of async thunks with bounded concurrency, so 2600+ requests don't all fire at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Tier A — crash/leak fuzz over every operation in openapi.json
// ---------------------------------------------------------------------------

interface Operation {
  method: string;
  path: string;
}

function loadOperations(): Operation[] {
  const openapiPath = resolve(import.meta.dir, "../../openapi.json");
  const doc = JSON.parse(readFileSync(openapiPath, "utf-8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const methods = ["get", "post", "put", "patch", "delete"];
  const operations: Operation[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const method of methods) {
      if (ops[method]) operations.push({ method: method.toUpperCase(), path });
    }
  }
  return operations;
}

describe("authz role matrix — Tier A: no route ever crashes or leaks, for any role", () => {
  integrationTest(
    "every operation x every role returns a well-formed response, never a raw 500",
    async () => {
      const operations = loadOperations();
      const cases = operations.flatMap((op) => ALL_ROLES.map((role) => ({ op, role })));

      const violations: string[] = [];

      await mapWithConcurrency(cases, 24, async ({ op, role }) => {
        const res = await requestAs(role, op.method, op.path);
        const label = `${op.method} ${op.path} as ${role}`;

        if (res.status === 500) {
          violations.push(`${label} -> 500 (unhandled crash)`);
          return;
        }

        if (res.status >= 400) {
          const contentType = res.headers.get("content-type");
          if (contentType !== "application/problem+json") {
            violations.push(
              `${label} -> ${res.status} with content-type "${contentType}" (expected application/problem+json)`,
            );
            return;
          }
          const body: unknown = await res.json();
          const parsed = apiProblemSchema.safeParse(body);
          if (!parsed.success) {
            violations.push(
              `${label} -> ${res.status} with a body that doesn't match the problem+json envelope`,
            );
          }
        }
      });

      if (violations.length > 0) {
        throw new Error(
          `${violations.length} route(s) crashed or leaked an error shape:\n` +
            violations.slice(0, 40).join("\n") +
            (violations.length > 40 ? `\n... and ${violations.length - 40} more` : ""),
        );
      }

      expect(violations).toHaveLength(0);
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------
// Tier B — every requirePermission() mount point, transcribed from src/
// ---------------------------------------------------------------------------

/**
 * One row per `routes.use(path, requirePermission(PERMISSIONS.X))` (or an equivalent
 * `onlyMethods`-wrapped / hoisted-variable mount) found in src/ as of this writing. `method` is the
 * verb the assertion below actually sends; for a mount mounted on every method at that path
 * (the common case — see module docstring above), GET is used unless the path has no GET
 * operation, in which case the row's own comment says which verb was picked instead.
 *
 * GUEST holds neither permission below (its only permissions, COURSE_READ/LESSON_READ, gate no
 * route that exists in this app's actual module set), so GUEST is the universal "must be denied"
 * probe. ORG_ADMIN holds every permission below (ORG_ADMIN = every permission except
 * USER_IMPERSONATE/ORGANIZATION_CREATE/ORGANIZATION_DELETE/API_KEY_*, none of which appear here),
 * so ORG_ADMIN is the universal "must not be denied by this gate" probe.
 */
interface GuardCase {
  method: string;
  path: string;
  permission: Permission;
  source: string;
  /**
   * Set when the permission gate is a floor, not the full story: the handler layers an additional
   * role-specific check on top (e.g. "must also be the STUDENT or PARENT, not just hold
   * grade:read"), so ORG_ADMIN holding the permission does not imply ORG_ADMIN is let through.
   * Names the extra restriction so the "must not be denied" half of this row is skipped rather
   * than asserting something the route was never meant to allow.
   */
  allowedRoleAlsoRestrictedBy?: string;
}

const GUARD_CASES: GuardCase[] = [
  {
    method: "GET",
    path: "/api/audit/logs",
    permission: "auditLog:read",
    source: "audit/routes.ts",
  },
  {
    method: "POST",
    path: "/api/audit/logs/export",
    permission: "auditLog:export",
    source: "audit/routes.ts",
  },
  {
    method: "GET",
    path: "/api/audit/logs/export/{jobId}",
    permission: "auditLog:export",
    source: "audit/routes.ts",
  },
  {
    method: "PATCH",
    path: "/api/attendance/records/{recordId}",
    permission: "attendance:record:correct",
    source: "attendance/corrections/routes/correction-routes.ts",
  },
  {
    method: "GET",
    path: "/api/attendance/records/{recordId}/history",
    permission: "attendance:record:read",
    source: "attendance/corrections/routes/correction-routes.ts",
  },
  {
    method: "POST",
    path: "/api/attendance/records/batch",
    permission: "attendance:record:create",
    source: "attendance/routes/attendance-session-routes.ts",
  },
  {
    method: "GET",
    path: "/api/attendance/reports/summary",
    permission: "attendance:report:read",
    source: "attendance/reports/routes.ts",
  },
  {
    method: "GET",
    path: "/api/attendance/reports/trends",
    permission: "attendance:report:read",
    source: "attendance/reports/routes.ts",
  },
  {
    method: "POST",
    path: "/api/attendance/reports/export",
    permission: "attendance:report:export",
    source: "attendance/reports/routes.ts",
  },
  {
    method: "GET",
    path: "/api/attendance/reports/export/{jobId}",
    permission: "attendance:report:export",
    source: "attendance/reports/routes.ts",
  },
  {
    method: "GET",
    path: "/api/users/status-counts",
    permission: "user:read",
    source: "users/routes/user-routes.ts",
  },
  {
    method: "PATCH",
    path: "/api/users/{userId}/role",
    permission: "role:assign",
    source: "users/routes/user-routes.ts",
  },
  {
    method: "PATCH",
    path: "/api/users/{userId}/deactivate",
    permission: "user:suspend",
    source: "users/routes/user-routes.ts",
  },
  {
    method: "GET",
    path: "/api/teachers",
    permission: "teacher:read",
    source: "users/routes/teacher-routes.ts",
  },
  {
    method: "GET",
    path: "/api/teachers/{teacherId}",
    permission: "teacher:read",
    source: "users/routes/teacher-routes.ts",
  },
  {
    method: "GET",
    path: "/api/students",
    permission: "student:read",
    source: "users/routes/student-routes.ts",
  },
  {
    method: "GET",
    path: "/api/students/{studentId}",
    permission: "student:read",
    source: "users/routes/student-routes.ts",
  },
  {
    method: "GET",
    path: "/api/students/{studentId}/guardians",
    permission: "student:read",
    source: "users/routes/student-routes.ts",
  },
  {
    method: "DELETE",
    path: "/api/students/{studentId}/guardians/{userId}",
    permission: "student:update",
    source: "users/routes/student-routes.ts",
  },
  {
    method: "GET",
    path: "/api/evaluations/templates",
    permission: "evaluationTemplate:read",
    source: "discipline/routes/evaluation-routes.ts",
  },
  {
    method: "GET",
    path: "/api/evaluations/templates/{templateId}",
    permission: "evaluationTemplate:read",
    source: "discipline/routes/evaluation-routes.ts",
  },
  {
    method: "GET",
    path: "/api/evaluations",
    permission: "evaluation:read",
    source: "discipline/routes/evaluation-routes.ts",
  },
  {
    method: "GET",
    path: "/api/evaluations/{evaluationId}",
    permission: "evaluation:read",
    source: "discipline/routes/evaluation-routes.ts",
  },
  {
    method: "GET",
    path: "/api/evaluations/{evaluationId}/scores",
    permission: "evaluationScore:read",
    source: "discipline/routes/evaluation-routes.ts",
  },
  {
    method: "GET",
    path: "/api/discipline/incidents",
    permission: "disciplineIncident:read",
    source: "discipline/routes/discipline-routes.ts",
  },
  {
    method: "GET",
    path: "/api/discipline/incidents/{incidentId}",
    permission: "disciplineIncident:read",
    source: "discipline/routes/discipline-routes.ts",
  },
  {
    method: "GET",
    path: "/api/discipline/incidents/{incidentId}/actions",
    permission: "disciplineAction:read",
    source: "discipline/routes/discipline-routes.ts",
  },
  {
    method: "GET",
    path: "/api/discipline/incidents/{incidentId}/actions/{actionId}",
    permission: "disciplineAction:read",
    source: "discipline/routes/discipline-routes.ts",
  },
  {
    method: "POST",
    path: "/api/families",
    permission: "parent:link",
    source: "users/families/routes.ts",
  },
  {
    method: "PATCH",
    path: "/api/families/{familyId}",
    permission: "parent:link",
    source: "users/families/routes.ts",
  },
  {
    method: "DELETE",
    path: "/api/families/{familyId}",
    permission: "parent:unlink",
    source: "users/families/routes.ts",
  },
  {
    method: "POST",
    path: "/api/families/{familyId}/links",
    permission: "parent:link",
    source: "users/families/routes.ts",
  },
  {
    method: "PATCH",
    path: "/api/families/{familyId}/links/{parentUserId}/{studentId}",
    permission: "parent:link",
    source: "users/families/routes.ts",
  },
  {
    method: "DELETE",
    path: "/api/families/{familyId}/links/{parentUserId}/{studentId}",
    permission: "parent:unlink",
    source: "users/families/routes.ts",
  },
  {
    method: "POST",
    path: "/api/invitations/bulk",
    permission: "user:invite",
    source: "auth/invitation/bulk-invite-routes.ts",
  },
  {
    method: "POST",
    path: "/api/invitations/bulk/{bulkInviteId}/retry",
    permission: "user:invite",
    source: "auth/invitation/bulk-invite-routes.ts",
  },
  {
    method: "DELETE",
    path: "/api/admin/users/{userId}/devices",
    permission: "user:suspend",
    source: "auth/routes/admin-device-routes.ts",
  },
  {
    method: "DELETE",
    path: "/api/admin/users/{userId}/devices/{deviceId}",
    permission: "user:suspend",
    source: "auth/routes/admin-device-routes.ts",
  },
  {
    method: "GET",
    path: "/api/admin/users/{userId}/sessions",
    permission: "user:suspend",
    source: "auth/routes/admin-device-routes.ts",
  },
  {
    method: "DELETE",
    path: "/api/admin/users/{userId}/providers/{provider}",
    permission: "user:suspend",
    source: "auth/routes/provider-link-routes.ts",
  },
  {
    method: "GET",
    path: "/api/reports/children/comparison",
    permission: "grade:read",
    source: "reports/routes.ts",
  },
  {
    method: "GET",
    path: "/api/reports/children/{studentId}/breakdown",
    permission: "grade:read",
    source: "reports/routes.ts",
  },
  {
    method: "PATCH",
    path: "/api/schools/current/settings",
    permission: "organization:manageSettings",
    source: "tenancy/settings/route.ts",
  },
  {
    method: "GET",
    path: "/api/grades/gradebooks",
    permission: "grade:read",
    source: "grades/routes/grade-entry-routes.ts",
  },
  {
    method: "POST",
    path: "/api/grades/gradebooks/{gradebookId}/assessments",
    permission: "grade:update",
    source: "grades/routes/grade-entry-routes.ts",
  },
  {
    method: "GET",
    path: "/api/grades/gradebooks/{gradebookId}/entry",
    permission: "grade:read",
    source: "grades/routes/grade-entry-routes.ts",
  },
  {
    method: "PATCH",
    path: "/api/grades/gradebooks/{gradebookId}/grades",
    permission: "grade:update",
    source: "grades/routes/grade-entry-routes.ts",
  },
  {
    method: "PATCH",
    path: "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/submit",
    permission: "grade:update",
    source: "grades/routes/grade-entry-routes.ts",
  },
  {
    method: "PATCH",
    path: "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/decide",
    permission: "grade:override",
    source: "grades/routes/grade-entry-routes.ts",
  },
  {
    method: "PATCH",
    path: "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/unlock",
    permission: "grade:update",
    source: "grades/routes/grade-entry-routes.ts",
  },
  {
    method: "POST",
    path: "/api/approvals/bulk-decision",
    permission: "approval:review",
    source: "grades/routes/approval-queue-routes.ts",
  },
  {
    method: "GET",
    path: "/api/grades/config/gradebooks/{gradebookId}/scheme",
    permission: "grade:read",
    source: "grades/config/routes/scheme-routes.ts",
  },
  {
    method: "POST",
    path: "/api/grades/config/gradebooks/{gradebookId}/scheme/link",
    permission: "grade:update",
    source: "grades/config/routes/scheme-routes.ts",
  },
  {
    method: "GET",
    path: "/api/grades/config/schemes",
    permission: "grade:read",
    source: "grades/config/routes/scheme-routes.ts",
  },
  {
    method: "GET",
    path: "/api/grades/config/schemes/{schemeId}",
    permission: "grade:read",
    source: "grades/config/routes/scheme-routes.ts",
  },
  {
    method: "GET",
    path: "/api/grades/config/gradebooks/{gradebookId}/categories",
    permission: "grade:read",
    source: "grades/config/routes/category-routes.ts",
  },
  {
    method: "GET",
    path: "/api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
    permission: "grade:read",
    source: "grades/config/routes/category-routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/fee-structures",
    permission: "billing:update",
    source: "finance/fee-structures/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/fee-structures/{feeStructureId}",
    permission: "billing:update",
    source: "finance/fee-structures/routes.ts",
  },
  {
    method: "GET",
    path: "/api/grades/published/students/{studentId}/terms/{termId}",
    permission: "grade:read",
    source: "grades/published/routes.ts",
    allowedRoleAlsoRestrictedBy: "caller must also be the STUDENT or PARENT (see routes.ts:71)",
  },
  {
    method: "GET",
    path: "/api/imports/students",
    permission: "student:import",
    source: "imports/routes/import-routes.ts",
  },
  {
    method: "GET",
    path: "/api/imports/students/template",
    permission: "student:read",
    source: "imports/routes/import-routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/expenses",
    permission: "billing:update",
    source: "finance/expenses/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/expenses/{expenseId}",
    permission: "billing:update",
    source: "finance/expenses/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/expenses/summary",
    permission: "billing:read",
    source: "finance/expenses/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/reports/ar-aging",
    permission: "report:viewFinancial",
    source: "finance/reports/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/reports/general-ledger",
    permission: "report:viewFinancial",
    source: "finance/reports/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/reports/collections-vs-due",
    permission: "report:viewFinancial",
    source: "finance/reports/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/reports/joinvoice/{invoiceId}",
    permission: "report:viewFinancial",
    source: "finance/reports/routes.ts",
  },
  {
    method: "POST",
    path: "/api/finance/reports/export",
    permission: "report:export",
    source: "finance/reports/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/reports/export/{jobId}",
    permission: "report:export",
    source: "finance/reports/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/scholarship-discounts",
    permission: "billing:read",
    source: "finance/scholarships/routes.ts",
  },
  {
    method: "POST",
    path: "/api/finance/scholarship-discounts/awards",
    permission: "billing:update",
    source: "finance/scholarships/routes.ts",
  },
  {
    method: "POST",
    path: "/api/finance/scholarship-discounts/awards/{awardId}/confirm",
    permission: "billing:update",
    source: "finance/scholarships/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/students/{studentId}/installments",
    permission: "billing:read",
    source: "finance/installments/routes.ts",
  },
  {
    method: "POST",
    path: "/api/finance/fee-schedules/generate",
    permission: "billing:update",
    source: "finance/installments/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/payments",
    permission: "billing:update",
    source: "finance/payments/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/payments/{paymentId}",
    permission: "billing:read",
    source: "finance/payments/routes.ts",
  },
  {
    method: "GET",
    path: "/api/subscriptions/current",
    permission: "organization:manageBilling",
    source: "subscriptions/routes/billing-overview-routes.ts",
  },
  {
    method: "POST",
    path: "/api/subscriptions/current/cancel",
    permission: "organization:manageBilling",
    source: "subscriptions/routes/cancellation-routes.ts",
  },
  {
    method: "POST",
    path: "/api/subscriptions/current/cancel/reverse",
    permission: "organization:manageBilling",
    source: "subscriptions/routes/cancellation-routes.ts",
  },
  {
    method: "POST",
    path: "/api/subscriptions/portal",
    permission: "organization:manageBilling",
    source: "subscriptions/routes/checkout-routes.ts",
  },
  {
    method: "GET",
    path: "/api/subscriptions/current/invoices",
    permission: "organization:manageBilling",
    source: "subscriptions/routes/invoice-routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/invoices",
    permission: "billing:read",
    source: "finance/invoices/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/invoices/batches/{batchId}",
    permission: "billing:read",
    source: "finance/invoices/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/invoices/{invoiceId}",
    permission: "billing:read",
    source: "finance/invoices/routes.ts",
  },
  {
    method: "GET",
    path: "/api/finance/refunds/{refundId}",
    permission: "billing:read",
    source: "finance/refunds/routes.ts",
  },
  {
    method: "POST",
    path: "/api/finance/refunds/initiate",
    permission: "billing:update",
    source: "finance/refunds/routes.ts",
  },
  {
    method: "POST",
    path: "/api/finance/refunds/{refundId}/approve",
    permission: "billing:refund",
    source: "finance/refunds/routes.ts",
  },
  {
    method: "POST",
    path: "/api/finance/refunds/{refundId}/reject",
    permission: "billing:refund",
    source: "finance/refunds/routes.ts",
  },
  {
    method: "GET",
    path: "/api/announcements",
    permission: "notification:manage",
    source: "announcements/routes.ts",
  },
];

describe("authz role matrix — Tier B: every requirePermission() mount point", () => {
  for (const { method, path, permission, source, allowedRoleAlsoRestrictedBy } of GUARD_CASES) {
    const deniedRole = ROLES.GUEST;
    const allowedRole = ROLES.ORG_ADMIN;

    test(`${deniedRole} lacks ${permission}, is denied on ${method} ${path} (${source})`, () => {
      expect(ROLE_PERMISSIONS[deniedRole].includes(permission)).toBe(false);
    });

    test(`${allowedRole} holds ${permission}, required by ${method} ${path} (${source})`, () => {
      expect(ROLE_PERMISSIONS[allowedRole].includes(permission)).toBe(true);
    });

    integrationTest(`${method} ${path} denies ${deniedRole} (${source})`, async () => {
      const res = await requestAs(deniedRole, method, path);
      expect([401, 403]).toContain(res.status);
      const body: unknown = await res.json();
      const parsed = apiProblemSchema.safeParse(body);
      expect(parsed.success).toBe(true);
    });

    integrationTest(
      `${method} ${path} does not deny ${allowedRole} on permission grounds (${source})` +
        (allowedRoleAlsoRestrictedBy ? ` [skipped: ${allowedRoleAlsoRestrictedBy}]` : ""),
      async () => {
        if (allowedRoleAlsoRestrictedBy) return;
        const res = await requestAs(allowedRole, method, path);
        expect(res.status).not.toBe(403);
      },
    );
  }
});
