/**
 * A parent opens a discipline incident by id (`GET /api/discipline/incidents/{id}`). They hold
 * disciplineIncident:read, which on its own let them open any incident in their school. They may
 * see only a resolved incident about their own child, and only when the school shows incidents to
 * parents; everything else reads as not found. Staff are unaffected, including a teacher who is
 * also a parent. Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL.
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  authenticatedRequest,
  createDisciplineIncident,
  createFullTenant,
  createStudent,
  createTestApp,
  createTestDatabase,
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

/** Writes as the migration owner, outside RLS, the way the factories seed fixtures. */
async function asOwner(run: (sql: TestDatabase["sql"]) => Promise<unknown>): Promise<void> {
  await run(database!.sql);
}

async function setParentVisibility(fixture: TenantFixture, visible: boolean): Promise<void> {
  await asOwner(
    (sql) => sql`
      INSERT INTO app.school_settings (school_id, parent_discipline_visibility)
      VALUES (${fixture.schoolId}::uuid, ${visible})
      ON CONFLICT (school_id) DO UPDATE SET parent_discipline_visibility = EXCLUDED.parent_discipline_visibility
    `,
  );
}

async function incident(
  fixture: TenantFixture,
  studentId: string,
  status: "reported" | "resolved",
): Promise<string> {
  const created = await createDisciplineIncident(database!.sql, fixture.schoolId, {
    studentId,
    reporterUserId: fixture.users.INSTRUCTOR!.id,
    title: `Incident (${status})`,
  });
  if (status === "resolved") {
    await asOwner(
      (sql) => sql`
        UPDATE app.discipline_incidents
           SET status = 'resolved', resolved_at = now(), updated_at = now()
         WHERE id = ${created.id}::uuid
      `,
    );
  }
  return created.id;
}

function as(fixture: TenantFixture, role: "PARENT" | "INSTRUCTOR", roles?: string[]) {
  return {
    schoolId: fixture.schoolId,
    userId: fixture.users[role]!.id,
    roles: (roles ?? [ROLES[role]]) as (typeof ROLES)[keyof typeof ROLES][],
  };
}

describeDb("GET /api/discipline/incidents/{id} for a parent", () => {
  test("a parent sees only their own child's resolved incidents", async () => {
    const fixture = await createFullTenant(database!.sql);
    const ownChild = fixture.students[0]!;
    const otherChild = await createStudent(database!.sql, fixture.schoolId);
    const parentId = fixture.users.PARENT!.id;
    const [family] = await database!.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${fixture.schoolId}::uuid, 'Family', ${parentId}::uuid)
      RETURNING id
    `;
    await database!.sql`
      INSERT INTO app.parent_child_links
        (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${fixture.schoolId}::uuid, ${family!.id}::uuid, ${parentId}::uuid,
              ${ownChild.id}::uuid, 'guardian')
    `;
    await setParentVisibility(fixture, true);

    const ownResolved = await incident(fixture, ownChild.id, "resolved");
    const ownOpen = await incident(fixture, ownChild.id, "reported");
    const othersResolved = await incident(fixture, otherChild.id, "resolved");

    const get = (id: string, auth = as(fixture, "PARENT")) =>
      authenticatedRequest(harness!, "GET", `/api/discipline/incidents/${id}`, auth);

    expect((await get(ownResolved)).status).toBe(200);
    // Not yet resolved, or about another family's child: not found, never "forbidden".
    expect((await get(ownOpen)).status).toBe(404);
    expect((await get(othersResolved)).status).toBe(404);

    // Staff are unaffected, including a teacher who is also a parent.
    expect((await get(othersResolved, as(fixture, "INSTRUCTOR"))).status).toBe(200);
    expect(
      (await get(othersResolved, as(fixture, "PARENT", [ROLES.PARENT, ROLES.INSTRUCTOR]))).status,
    ).toBe(200);

    // When the school does not show incidents to parents, not even their own child's.
    await setParentVisibility(fixture, false);
    expect((await get(ownResolved)).status).toBe(403);
  });
});
