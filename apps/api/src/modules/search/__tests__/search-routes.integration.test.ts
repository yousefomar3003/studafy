/**
 * ST-278 global search — live-PostgreSQL integration test.
 *
 * Mounts the real route on a real tenant transaction and asserts the property the ticket's
 * acceptance criteria actually turn on: "results respect role scope (finance finds invoices,
 * teacher does not)". Three callers run the exact same queries against the exact same seeded rows:
 *
 *   - INSTRUCTOR (the class's real lead teacher, not the role-loop fixture user -- see
 *     material-toggle.integration.test.ts's identical note): finds the student and the material via
 *     RLS (`can_read_student` / `can_read_class`), never invoices or users (no BILLING_READ /
 *     USER_READ in `packages/constants/src/permissions.ts`).
 *   - FINANCE (a plain user with no teaching or admin relationship to anyone): finds the invoice by
 *     its docname and finds users, never students or materials (no STUDENT_READ / MATERIAL_READ).
 *     Its invoice hit's `student_name` is null -- FINANCE cannot read the linked `app.students` row
 *     under `role_scope_visibility` -- proving the deliberate `LEFT JOIN` in `searchInvoices`.
 *   - ORG_ADMIN: finds everything, and its invoice hit's `student_name` is non-null -- the same
 *     `LEFT JOIN` opportunistically enriching once RLS actually allows the read.
 *
 * A fourth check asserts the search itself is durably audited ("audited for sensitive queries").
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/search/__tests__/search-routes.integration.test.ts
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  assignRole,
  createFullTenant,
  createMaterial,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TenantFixture,
  type TestDatabase,
} from "../../../../tests/harness";
import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { searchRoutes } from "../routes";

import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

let db: TestDatabase;
let adminClient: ReturnType<typeof postgres> | undefined;
let tenantClient: ReturnType<typeof postgres> | undefined;
let tenant: TenantFixture;
let searchApp: OpenAPIHono<AppEnv>;
let auth: AuthContext;

let financeUserId: string;
let materialTitle: string;
let invoiceDocname: string;

const STUDENT_QUERY = "TestStudent";

/** Seed a scoped row the way the fixtures do: school GUC first, then studafy_admin. */
async function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await adminClient!.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

function buildSearchApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/", searchRoutes(tenantClient!));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

async function search(query: string): Promise<{
  status: number;
  body: {
    results: {
      students: unknown[];
      users: unknown[];
      invoices: { erpnext_docname: string; student_name: string | null }[];
      materials: unknown[];
    };
  };
}> {
  const res = await searchApp.request(`/api/search?q=${encodeURIComponent(query)}`);
  return { status: res.status, body: (await res.json()) as never };
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  // bun 1.3.14 + postgres.js: a pooled `sql.begin` issued after seeding can hang -- the same
  // environment note as material-toggle.integration.test.ts. Route every BEGIN through pinned
  // single connections and split admin seeding from tenant transactions.
  adminClient = postgres(db.url, { max: 1, prepare: false });
  tenantClient = postgres(db.url, { max: 1, prepare: false });

  tenant = await createFullTenant(db.sql);

  const material = await createMaterial(db.sql, tenant.schoolId, {
    classId: tenant.cls.id,
    uploadedByUserId: tenant.teachers[0]!.userId,
    title: "Zoology Field Guide",
  });
  materialTitle = material.title;

  // A plain user with no teaching or admin relationship to the student, and no seeded role beyond
  // FINANCE -- exactly the caller `role_scope_visibility` denies student/material access to.
  const financeUser = await createUser(db.sql, tenant.schoolId, {
    email: `finance-search@test-${tenant.schoolSlug}.local`,
    displayName: "Finance Search Tester",
  });
  await assignRole(db.sql, tenant.schoolId, financeUser.id, "FINANCE");
  financeUserId = financeUser.id;

  invoiceDocname = `INV-SEARCH-${tenant.schoolSlug.slice(0, 8).toUpperCase()}`;
  await asAdmin(tenant.schoolId, async (tx) => {
    const [school] = await tx<{ default_currency_id: string }[]>`
      SELECT default_currency_id FROM app.schools WHERE id = ${tenant.schoolId}
    `;
    await tx`
      INSERT INTO app.invoice_cache
        (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
         total_amount_minor, outstanding_amount_minor, issued_date, last_synced_at)
      VALUES (
        ${tenant.schoolId}, ${tenant.students[0]!.id}, ${school!.default_currency_id},
        ${invoiceDocname}, 'submitted', 150000, 150000, '2026-01-01', now()
      )
    `;
  });

  searchApp = buildSearchApp();
});

afterAll(async () => {
  if (tenantClient) await tenantClient.end({ timeout: 1 });
  if (adminClient) await adminClient.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

function authAs(userId: string, roles: AuthContext["roles"], jti: string): void {
  auth = {
    userId,
    schoolId: tenant.schoolId,
    roles,
    channel: AUTH_CHANNELS.API,
    jti,
    entitlementsVer: 1,
    subscriptionStatus: "active",
  };
}

describeDb("GET /api/search — role scope", () => {
  test("INSTRUCTOR finds the student and the material, never invoices or users", async () => {
    // tenant.teachers[0] is the class's real lead teacher, not tenant.users.INSTRUCTOR (who teaches
    // no class) -- can_read_class/can_read_student resolve the acting user via app.teachers.user_id.
    authAs(tenant.teachers[0]!.userId, [ROLES.INSTRUCTOR], "jti-instructor");

    const studentHit = await search(STUDENT_QUERY);
    expect(studentHit.status).toBe(200);
    expect(studentHit.body.results.students).toHaveLength(1);
    expect(studentHit.body.results.invoices).toEqual([]);
    expect(studentHit.body.results.users).toEqual([]);

    const materialHit = await search(materialTitle);
    expect(materialHit.body.results.materials).toHaveLength(1);
    expect(materialHit.body.results.invoices).toEqual([]);
    expect(materialHit.body.results.users).toEqual([]);

    // Even a query that would match the invoice/a user is refused a hit in those sections --
    // section visibility is a permission gate, not a query-shape coincidence.
    const invoiceQuery = await search(invoiceDocname);
    expect(invoiceQuery.body.results.invoices).toEqual([]);
  });

  test("FINANCE finds the invoice by docname and finds users, never students or materials", async () => {
    authAs(financeUserId, [ROLES.FINANCE], "jti-finance");

    const invoiceHit = await search(invoiceDocname);
    expect(invoiceHit.status).toBe(200);
    expect(invoiceHit.body.results.invoices).toHaveLength(1);
    expect(invoiceHit.body.results.invoices[0]!.erpnext_docname).toBe(invoiceDocname);
    // FINANCE holds neither the school-admin nor the teacher/parent relationship
    // role_scope_visibility checks, so the linked app.students row is invisible to it under RLS --
    // the invoice still surfaces (LEFT JOIN), just without the enrichment.
    expect(invoiceHit.body.results.invoices[0]!.student_name).toBeNull();

    const userHit = await search("Finance Search Tester");
    expect(userHit.body.results.users.length).toBeGreaterThan(0);

    const studentQuery = await search(STUDENT_QUERY);
    expect(studentQuery.body.results.students).toEqual([]);

    const materialQuery = await search(materialTitle);
    expect(materialQuery.body.results.materials).toEqual([]);
  });

  test("ORG_ADMIN finds everything, and the invoice's student_name is enriched", async () => {
    authAs(tenant.users.ORG_ADMIN!.id, [ROLES.ORG_ADMIN], "jti-admin");

    const invoiceHit = await search(invoiceDocname);
    expect(invoiceHit.body.results.invoices).toHaveLength(1);
    expect(invoiceHit.body.results.invoices[0]!.student_name).toBe("Primary TestStudent");

    const studentHit = await search(STUDENT_QUERY);
    expect(studentHit.body.results.students).toHaveLength(1);

    const materialHit = await search(materialTitle);
    expect(materialHit.body.results.materials).toHaveLength(1);

    const userHit = await search("Finance Search Tester");
    expect(userHit.body.results.users.length).toBeGreaterThan(0);
  });

  test("rejects a query shorter than the minimum length", async () => {
    authAs(tenant.users.ORG_ADMIN!.id, [ROLES.ORG_ADMIN], "jti-short-query");

    const res = await searchApp.request("/api/search?q=a");
    expect(res.status).toBe(400);
  });

  test("writes a 'read' audit row against 'global_search' for every call", async () => {
    authAs(tenant.users.ORG_ADMIN!.id, [ROLES.ORG_ADMIN], "jti-audit");
    await search(invoiceDocname);

    const rows = await db.sql<{ new_values: { query: string } }[]>`
      SELECT new_values
      FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}
        AND target_table = 'global_search'
        AND actor_id = ${tenant.users.ORG_ADMIN!.id}
        AND action = 'read'::app.audit_action
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.new_values.query === invoiceDocname)).toBe(true);
  });
});
