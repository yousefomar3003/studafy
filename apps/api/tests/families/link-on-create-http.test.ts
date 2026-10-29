/**
 * Linking at creation time: `POST /api/users` with `children` (a new PARENT linked to students) and
 * `POST /api/students` with `guardians` (a new student linked to parents). Both go through the same
 * insert + audit path as the Guardians tab (linkParentToStudent), give each link a family through
 * resolveGuardianFamily, run in the creating transaction, and need parent:link on top of the create
 * permission. Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/families/link-on-create-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createStudent,
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

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
  channel: "web";
}

function adminOf(fixture: TenantFixture): Actor {
  return {
    schoolId: fixture.schoolId,
    userId: fixture.users.ORG_ADMIN.id,
    roles: [ROLES.ORG_ADMIN],
    channel: "web",
  };
}

function post(actor: Actor, path: string, body: unknown) {
  return authenticatedRequest(harness!, "POST", path, actor, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function parentUser(schoolId: string) {
  const user = await createUser(database!.sql, schoolId, {
    email: `parent-${crypto.randomUUID().slice(0, 8)}@test.local`,
    displayName: "Rana Haddad",
  });
  await assignRole(database!.sql, schoolId, user.id, ROLES.PARENT);
  return user;
}

/** Plain rows (not postgres.js's RowList), so a test can compare them to `[]`. */
async function linksOf(schoolId: string, column: "parent_user_id" | "student_id", id: string) {
  const rows = await database!.sql<
    { family_id: string; parent_user_id: string; student_id: string; relationship: string }[]
  >`
    SELECT family_id, parent_user_id, student_id, relationship
    FROM app.parent_child_links
    WHERE school_id = ${schoolId}::uuid AND ${database!.sql(column)} = ${id}::uuid
    ORDER BY student_id, parent_user_id
  `;
  return [...rows];
}

async function linkAudits(schoolId: string) {
  const [row] = await database!.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.audit_logs
    WHERE school_id = ${schoolId}::uuid AND target_table = 'parent_child_links' AND action = 'insert'
  `;
  return row!.count;
}

async function userCountByEmail(schoolId: string, email: string) {
  const [row] = await database!.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.users
    WHERE school_id = ${schoolId}::uuid AND normalized_email = ${email}
  `;
  return row!.count;
}

describeDb("creating a parent with children", () => {
  test("links every child in one household, audited like any other link", async () => {
    const fixture = await createFullTenant(database!.sql);
    const sibling = await createStudent(database!.sql, fixture.schoolId);

    const response = await post(adminOf(fixture), "/api/users", {
      email: "new-parent@test.local",
      display_name: "Rana Haddad",
      role: "PARENT",
      children: [
        { student_id: fixture.students[0]!.id, relationship: "mother" },
        { student_id: sibling.id, relationship: "mother" },
      ],
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; roles: string[] };
    expect(created.roles).toEqual(["PARENT"]);

    const links = await linksOf(fixture.schoolId, "parent_user_id", created.id);
    expect(links.map((l) => l.student_id).sort()).toEqual(
      [fixture.students[0]!.id, sibling.id].sort(),
    );
    expect(new Set(links.map((l) => l.family_id)).size).toBe(1);

    const [family] = await database!.sql<
      { primary_parent_user_id: string; display_name: string }[]
    >`
      SELECT primary_parent_user_id, display_name FROM app.families WHERE id = ${links[0]!.family_id}::uuid
    `;
    expect(family).toEqual({ primary_parent_user_id: created.id, display_name: "Rana Haddad" });
    expect(await linkAudits(fixture.schoolId)).toBe(2);
  });

  test("a child that cannot be linked rolls the whole account back", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);

    const response = await post(adminOf(fixture), "/api/users", {
      email: "rolled-back@test.local",
      display_name: "Rana Haddad",
      role: "PARENT",
      children: [
        { student_id: fixture.students[0]!.id, relationship: "mother" },
        // Another school's student does not exist here.
        { student_id: other.students[0]!.id, relationship: "mother" },
      ],
    });
    expect(response.status).toBe(404);
    expect(await userCountByEmail(fixture.schoolId, "rolled-back@test.local")).toBe(0);
    expect(await linksOf(fixture.schoolId, "student_id", fixture.students[0]!.id)).toEqual([]);
    expect(await linksOf(other.schoolId, "student_id", other.students[0]!.id)).toEqual([]);
  });

  test("children are refused for a non-PARENT role and when a student is listed twice", async () => {
    const fixture = await createFullTenant(database!.sql);
    const child = { student_id: fixture.students[0]!.id, relationship: "guardian" };

    const teacher = await post(adminOf(fixture), "/api/users", {
      email: "teacher-with-kids@test.local",
      display_name: "Not A Parent",
      role: "INSTRUCTOR",
      children: [child],
    });
    expect(teacher.status).toBe(400);

    const twice = await post(adminOf(fixture), "/api/users", {
      email: "twice@test.local",
      display_name: "Rana Haddad",
      role: "PARENT",
      children: [child, child],
    });
    expect(twice.status).toBe(400);
    expect(await linksOf(fixture.schoolId, "student_id", fixture.students[0]!.id)).toEqual([]);
  });

  test("a caller without user:create cannot create, let alone link", async () => {
    const fixture = await createFullTenant(database!.sql);
    const principal = await createUser(database!.sql, fixture.schoolId);
    await assignRole(database!.sql, fixture.schoolId, principal.id, ROLES.PRINCIPAL);

    const response = await post(
      {
        schoolId: fixture.schoolId,
        userId: principal.id,
        roles: [ROLES.PRINCIPAL],
        channel: "web",
      },
      "/api/users",
      {
        email: "denied@test.local",
        display_name: "Rana Haddad",
        role: "PARENT",
        children: [{ student_id: fixture.students[0]!.id, relationship: "mother" }],
      },
    );
    expect(response.status).toBe(403);
    expect(await userCountByEmail(fixture.schoolId, "denied@test.local")).toBe(0);
    expect(await linkAudits(fixture.schoolId)).toBe(0);
  });
});

describeDb("creating a student with guardians", () => {
  test("links the guardian into their existing household and audits the link", async () => {
    const fixture = await createFullTenant(database!.sql);
    const parent = await parentUser(fixture.schoolId);
    const admin = adminOf(fixture);

    const first = await post(admin, "/api/students", {
      admission_number: "ADM-SIB-1",
      first_name: "Lina",
      last_name: "Haddad",
      status: "enrolled",
      guardians: [{ parent_user_id: parent.id, relationship: "mother" }],
    });
    expect(first.status).toBe(201);
    const second = await post(admin, "/api/students", {
      admission_number: "ADM-SIB-2",
      first_name: "Omar",
      last_name: "Haddad",
      status: "enrolled",
      guardians: [{ parent_user_id: parent.id, relationship: "mother" }],
    });
    expect(second.status).toBe(201);

    const links = await linksOf(fixture.schoolId, "parent_user_id", parent.id);
    expect(links.length).toBe(2);
    // The second child joins the household the first link created: siblings, one family.
    expect(new Set(links.map((l) => l.family_id)).size).toBe(1);
    expect(await linkAudits(fixture.schoolId)).toBe(2);
  });

  test("a non-parent guardian rolls the student back", async () => {
    const fixture = await createFullTenant(database!.sql);

    const response = await post(adminOf(fixture), "/api/students", {
      admission_number: "ADM-NOT-PARENT",
      first_name: "Lina",
      last_name: "Haddad",
      guardians: [{ parent_user_id: fixture.users.INSTRUCTOR.id, relationship: "guardian" }],
    });
    expect(response.status).toBe(400);

    const [row] = await database!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.students
      WHERE school_id = ${fixture.schoolId}::uuid AND admission_number = 'ADM-NOT-PARENT'
    `;
    expect(row!.count).toBe(0);
  });

  test("another school's parent cannot be linked", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);

    const response = await post(adminOf(fixture), "/api/students", {
      admission_number: "ADM-FOREIGN",
      first_name: "Lina",
      last_name: "Haddad",
      guardians: [{ parent_user_id: other.users.PARENT.id, relationship: "mother" }],
    });
    expect(response.status).toBe(404);
    expect(await linksOf(other.schoolId, "parent_user_id", other.users.PARENT.id)).toEqual([]);
  });
});
