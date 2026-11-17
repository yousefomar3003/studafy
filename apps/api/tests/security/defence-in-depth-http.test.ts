/**
 * QA-086: permission gates that do not rely on RLS alone, and 403 before 400.
 *
 * - Several list GETs had no permission gate, only RLS: a GUEST got 200 (scoped to nothing harmful
 *   today, but one RLS slip from a leak). They now require the permission their readers hold.
 * - Write routes checked the permission inside the handler, after the body was validated, so an
 *   unauthorised caller got 400 with the schema's complaints instead of 403.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/defence-in-depth-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  authenticatedRequest,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase, TenantFixture } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

function as(role: Role, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    {
      schoolId: tenant.schoolId,
      userId: tenant.users[role]?.id ?? tenant.users[ROLES.STUDENT]!.id,
      roles: [role],
      channel: "web",
    },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

describeDb("explicit gates on list reads (QA-086)", () => {
  test("a guest cannot list a class's enrollments or attendance sessions", async () => {
    expect(
      (await as(ROLES.GUEST, "GET", `/api/academics/classes/${tenant.cls.id}/enrollments`)).status,
    ).toBe(403);
    expect((await as(ROLES.GUEST, "GET", "/api/attendance/sessions")).status).toBe(403);
  });

  test("a parent cannot list classes or sections", async () => {
    expect((await as(ROLES.PARENT, "GET", "/api/academics/classes")).status).toBe(403);
    expect((await as(ROLES.PARENT, "GET", "/api/academics/sections")).status).toBe(403);
  });

  test("the roles that read them still do", async () => {
    expect(
      (await as(ROLES.ORG_ADMIN, "GET", `/api/academics/classes/${tenant.cls.id}/enrollments`))
        .status,
    ).toBe(200);
    expect((await as(ROLES.ORG_ADMIN, "GET", "/api/attendance/sessions")).status).toBe(200);
    expect((await as(ROLES.STUDENT, "GET", "/api/academics/classes")).status).toBe(200);
  });
});

describeDb("403 before 400 on writes (QA-086)", () => {
  test("an unauthorised caller learns nothing about the body's schema", async () => {
    expect(
      (await as(ROLES.STUDENT, "POST", "/api/discipline/incidents", { nonsense: true })).status,
    ).toBe(403);
    expect((await as(ROLES.PARENT, "POST", "/api/announcements", { nonsense: true })).status).toBe(
      403,
    );
  });

  test("an authorised caller still gets 400 for a bad body", async () => {
    expect(
      (await as(ROLES.ORG_ADMIN, "POST", "/api/discipline/incidents", { nonsense: true })).status,
    ).toBe(400);
  });
});
