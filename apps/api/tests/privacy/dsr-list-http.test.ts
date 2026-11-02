/**
 * The school's list of data subject requests (`GET /api/privacy/dsr`): a school admin sees every
 * per-person export and erasure in their school, newest first and filterable to one person, but
 * never a closure's whole-school request or another school's; a principal (no privacy:manageDsr)
 * is refused. Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/privacy/dsr-list-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

async function file(
  fixture: TenantFixture,
  subjectUserId: string | null,
  requestType: "export" | "erasure",
  createdAt: string,
): Promise<string> {
  const scope = subjectUserId ? "user" : "tenant";
  const [row] = await database!.sql<{ id: string }[]>`
    INSERT INTO app.data_subject_requests
      (school_id, request_type, subject_scope, reason, subject_user_id, requested_by_user_id,
       sla_due_at, created_at, updated_at)
    VALUES (
      ${fixture.schoolId}, ${requestType}, ${scope}::app.dsr_subject_scope,
      ${subjectUserId ? "user_request" : "tenant_closure"}::app.dsr_reason, ${subjectUserId},
      ${fixture.users.ORG_ADMIN!.id}, ${createdAt}::timestamptz + interval '30 days',
      ${createdAt}::timestamptz, ${createdAt}::timestamptz
    )
    RETURNING id
  `;
  return row!.id;
}

function admin(fixture: TenantFixture) {
  return {
    schoolId: fixture.schoolId,
    userId: fixture.users.ORG_ADMIN!.id,
    roles: [ROLES.ORG_ADMIN],
  };
}

describeDb("GET /api/privacy/dsr", () => {
  test("lists the school's per-person requests newest first, filterable to one person", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const parent = fixture.users.PARENT!;
    const teacher = fixture.users.INSTRUCTOR!;

    const older = await file(fixture, parent.id, "export", "2026-09-01T08:00:00Z");
    const newer = await file(fixture, teacher.id, "erasure", "2026-10-01T08:00:00Z");
    await file(fixture, null, "export", "2026-10-02T08:00:00Z");
    await file(other, other.users.PARENT!.id, "export", "2026-10-03T08:00:00Z");

    const res = await authenticatedRequest(harness!, "GET", "/api/privacy/dsr", admin(fixture));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      requests: { id: string; subject_user_id: string; request_type: string; status: string }[];
    };
    expect(body.requests.map((r) => r.id)).toEqual([newer, older]);
    expect(body.requests[0]).toMatchObject({
      subject_user_id: teacher.id,
      request_type: "erasure",
      status: "queued",
      subject_display_name: expect.any(String),
      download_url: null,
    });

    const filtered = await authenticatedRequest(
      harness!,
      "GET",
      `/api/privacy/dsr?subject_user_id=${parent.id}`,
      admin(fixture),
    );
    expect(((await filtered.json()) as { requests: { id: string }[] }).requests).toEqual([
      expect.objectContaining({ id: older }),
    ]);
  });

  test("a principal, who files no privacy requests, is refused", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await createUser(database!.sql, fixture.schoolId, {
      email: `principal-${crypto.randomUUID().slice(0, 8)}@test.local`,
    });
    await assignRole(database!.sql, fixture.schoolId, principal.id, ROLES.PRINCIPAL);

    const res = await authenticatedRequest(harness!, "GET", "/api/privacy/dsr", {
      schoolId: fixture.schoolId,
      userId: principal.id,
      roles: [ROLES.PRINCIPAL],
    });
    expect(res.status).toBe(403);
  });
});
