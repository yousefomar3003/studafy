/**
 * School calendar events HTTP tests (000121).
 *
 * Full HTTP path — JWT auth, permission gates, a real tenant transaction with RLS armed, and the
 * audit rows the service writes — for /api/school-events. Requires a live PostgreSQL instance, gated
 * on TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/school-events/school-events-http.test.ts
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
import type { Role } from "@studafy/constants";

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

interface SchoolEventResponse {
  id: string;
  title: string;
  kind: string;
  starts_on: string;
  ends_on: string;
  description: string | null;
}

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
}

async function principalOf(fixture: TenantFixture): Promise<Actor> {
  const user = await createUser(database!.sql, fixture.schoolId, {
    email: `principal-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.PRINCIPAL);
  return { schoolId: fixture.schoolId, userId: user.id, roles: [ROLES.PRINCIPAL] };
}

function actorOf(fixture: TenantFixture, role: Exclude<Role, "PRINCIPAL" | "FINANCE">): Actor {
  // eslint-disable-next-line security/detect-object-injection -- `role` is a fixed Role literal from the test itself, never external input
  return { schoolId: fixture.schoolId, userId: fixture.users[role].id, roles: [role] };
}

function request(actor: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    actor,
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

const HOLIDAY = {
  title: "Spring break",
  kind: "holiday",
  starts_on: "2026-03-23",
  ends_on: "2026-03-27",
};

describeDb("school events HTTP", () => {
  test("a principal adds an event, it lists in an overlapping window, and the add is audited", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await principalOf(fixture);

    const created = await request(principal, "POST", "/api/school-events", HOLIDAY);
    expect(created.status).toBe(201);
    const event = (await created.json()) as SchoolEventResponse;
    expect(event).toMatchObject({ ...HOLIDAY, description: null });

    // Overlaps only the last day of the holiday.
    const overlapping = await request(
      principal,
      "GET",
      "/api/school-events?from=2026-03-27&to=2026-04-30",
    );
    expect(overlapping.status).toBe(200);
    const { items } = (await overlapping.json()) as { items: SchoolEventResponse[] };
    expect(items.map((item) => item.id)).toEqual([event.id]);

    const outside = await request(
      principal,
      "GET",
      "/api/school-events?from=2026-04-01&to=2026-04-30",
    );
    expect(((await outside.json()) as { items: unknown[] }).items).toEqual([]);

    const audit = await database!.sql<{ action: string }[]>`
      SELECT action::text AS action FROM app.audit_logs
      WHERE school_id = ${fixture.schoolId} AND target_table = 'school_events'
        AND target_id = ${event.id}
    `;
    expect(audit.map((row) => row.action)).toEqual(["insert"]);
  });

  test("teachers can read the calendar but not change it; students cannot read it", async () => {
    const fixture = await createFullTenant(database!.sql);
    const window = "/api/school-events?from=2026-01-01&to=2026-12-31";

    expect((await request(actorOf(fixture, "INSTRUCTOR"), "GET", window)).status).toBe(200);
    expect(
      (await request(actorOf(fixture, "INSTRUCTOR"), "POST", "/api/school-events", HOLIDAY)).status,
    ).toBe(403);
    expect((await request(actorOf(fixture, "STUDENT"), "GET", window)).status).toBe(403);
    expect(
      (await request(actorOf(fixture, "ORG_ADMIN"), "POST", "/api/school-events", HOLIDAY)).status,
    ).toBe(201);
  });

  test("rejects an end date before the start date and an over-long window", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await principalOf(fixture);

    const backwards = await request(principal, "POST", "/api/school-events", {
      ...HOLIDAY,
      starts_on: "2026-03-27",
      ends_on: "2026-03-23",
    });
    expect(backwards.status).toBe(400);

    const tooLong = await request(
      principal,
      "GET",
      "/api/school-events?from=2025-01-01&to=2026-12-31",
    );
    expect(tooLong.status).toBe(400);
  });

  test("edits and removes an event; a one-sided edit can't invert the range", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await principalOf(fixture);
    const created = (await (
      await request(principal, "POST", "/api/school-events", HOLIDAY)
    ).json()) as SchoolEventResponse;
    const path = `/api/school-events/${created.id}`;

    const edited = await request(principal, "PATCH", path, { title: "Spring holiday" });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as SchoolEventResponse).title).toBe("Spring holiday");

    const inverted = await request(principal, "PATCH", path, { ends_on: "2026-03-01" });
    expect(inverted.status).toBe(400);

    expect((await request(principal, "DELETE", path)).status).toBe(204);
    expect((await request(principal, "DELETE", path)).status).toBe(404);
  });

  test("another school's principal can neither see nor change the event", async () => {
    const home = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const created = (await (
      await request(await principalOf(home), "POST", "/api/school-events", HOLIDAY)
    ).json()) as SchoolEventResponse;
    const outsider = await principalOf(other);

    const listed = await request(
      outsider,
      "GET",
      "/api/school-events?from=2026-01-01&to=2026-12-31",
    );
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
    expect(
      (await request(outsider, "PATCH", `/api/school-events/${created.id}`, { title: "x" })).status,
    ).toBe(404);
    expect((await request(outsider, "DELETE", `/api/school-events/${created.id}`)).status).toBe(
      404,
    );
  });
});
