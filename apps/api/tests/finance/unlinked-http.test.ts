/**
 * Unlinked people and the invoice batch preflight: enrolled students no guardian is linked to,
 * PARENT accounts linked to no child, and how many of a batch's targets have no family. All three
 * read through the finance identity transaction, so FINANCE (billing:read, no student:read) sees
 * them; nothing here links anyone. Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL
 * like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/finance/unlinked-http.test.ts
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
}

interface Unlinked {
  students: { id: string; name: string; admission_number: string }[];
  parents: { user_id: string; name: string; email: string | null; status: string }[];
  total: number;
}

interface Preflight {
  total_count: number;
  unlinked_count: number;
  unlinked_students: { id: string; name: string; admission_number: string }[];
}

async function financeOf(fixture: TenantFixture): Promise<Actor> {
  const user = await createUser(database!.sql, fixture.schoolId, {
    email: `finance-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.FINANCE);
  return { schoolId: fixture.schoolId, userId: user.id, roles: [ROLES.FINANCE] };
}

function teacherOf(fixture: TenantFixture): Actor {
  return {
    schoolId: fixture.schoolId,
    userId: fixture.users.INSTRUCTOR.id,
    roles: [ROLES.INSTRUCTOR],
  };
}

async function parentUser(schoolId: string, displayName: string) {
  const user = await createUser(database!.sql, schoolId, {
    email: `parent-${crypto.randomUUID().slice(0, 8)}@test.local`,
    displayName,
  });
  await assignRole(database!.sql, schoolId, user.id, ROLES.PARENT);
  return user;
}

/** A link exactly as the API makes one: a family, then the link row in it. */
async function link(schoolId: string, parentUserId: string, studentId: string) {
  const [family] = await database!.sql<{ id: string }[]>`
    INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
    VALUES (${schoolId}::uuid, 'Family', ${parentUserId}::uuid)
    RETURNING id
  `;
  await database!.sql`
    INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
    VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${parentUserId}::uuid, ${studentId}::uuid, 'mother')
  `;
}

async function get(actor: Actor, path: string) {
  return authenticatedRequest(harness!, "GET", path, actor);
}

async function preflight(actor: Actor, target: Record<string, unknown>) {
  return authenticatedRequest(harness!, "POST", "/api/finance/invoices/batches/preflight", actor, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
  });
}

describeDb("unlinked students and parents", () => {
  test("finance lists enrolled students with no guardian and parents with no children", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const linkedParent = await parentUser(fixture.schoolId, "Rana Linked");
    const loneParent = await parentUser(fixture.schoolId, "Sami Alone");
    const linked = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Lina",
      lastName: "Linked",
    });
    const unlinked = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Omar",
      lastName: "Alone",
    });
    const applicant = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Nour",
      lastName: "Applicant",
    });
    await database!.sql`
      UPDATE app.students SET status = 'applicant' WHERE id = ${applicant.id}::uuid
    `;
    await link(fixture.schoolId, linkedParent.id, linked.id);

    const students = await get(finance, "/api/finance/unlinked/students");
    expect(students.status).toBe(200);
    const studentList = (await students.json()) as Unlinked;
    // The fixture's own student has no guardian either; the applicant is not enrolled.
    expect(studentList.students.map((s) => s.id).sort()).toEqual(
      [fixture.students[0]!.id, unlinked.id].sort(),
    );
    expect(studentList.total).toBe(2);

    const parents = await get(finance, "/api/finance/unlinked/parents");
    expect(parents.status).toBe(200);
    const parentList = (await parents.json()) as Unlinked;
    // The fixture's PARENT user has no children either.
    expect(parentList.parents.map((p) => p.user_id).sort()).toEqual(
      [fixture.users.PARENT.id, loneParent.id].sort(),
    );

    const summary = await get(finance, "/api/finance/unlinked/summary");
    expect(summary.status).toBe(200);
    expect(await summary.json()).toEqual({ students: 2, parents: 2 });
  });

  test("search narrows each list and pages report the full total", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const omar = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Omar",
      lastName: "Saleh",
    });
    await parentUser(fixture.schoolId, "Sami Haddad");

    const byName = (await (
      await get(finance, "/api/finance/unlinked/students?search=oma")
    ).json()) as Unlinked;
    expect(byName.students.map((s) => s.id)).toEqual([omar.id]);

    const byAdmission = (await (
      await get(
        finance,
        `/api/finance/unlinked/students?search=${encodeURIComponent(omar.admissionNumber)}`,
      )
    ).json()) as Unlinked;
    expect(byAdmission.students.map((s) => s.id)).toEqual([omar.id]);

    const parents = (await (
      await get(finance, "/api/finance/unlinked/parents?search=haddad")
    ).json()) as Unlinked;
    expect(parents.parents.map((p) => p.name)).toEqual(["Sami Haddad"]);

    const firstPage = (await (
      await get(finance, "/api/finance/unlinked/students?limit=1&offset=0")
    ).json()) as Unlinked;
    expect(firstPage.students.length).toBe(1);
    expect(firstPage.total).toBe(2);
  });

  test("another school's unlinked people never appear", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    await parentUser(other.schoolId, "Elsewhere Parent");

    const students = (await (
      await get(finance, "/api/finance/unlinked/students")
    ).json()) as Unlinked;
    expect(students.students.some((s) => s.id === other.students[0]!.id)).toBe(false);

    const parents = (await (
      await get(finance, "/api/finance/unlinked/parents")
    ).json()) as Unlinked;
    expect(parents.parents.some((p) => p.user_id === other.users.PARENT.id)).toBe(false);
    expect(parents.parents.some((p) => p.name === "Elsewhere Parent")).toBe(false);

    expect(await (await get(finance, "/api/finance/unlinked/summary")).json()).toEqual({
      students: 1,
      parents: 1,
    });
  });

  test("a role without billing:read is refused", async () => {
    const fixture = await createFullTenant(database!.sql);
    const teacher = teacherOf(fixture);
    for (const path of [
      "/api/finance/unlinked/students",
      "/api/finance/unlinked/parents",
      "/api/finance/unlinked/summary",
    ]) {
      expect((await get(teacher, path)).status).toBe(403);
    }
  });
});

describeDb("invoice batch preflight", () => {
  test("counts and names the targets with no family, and creates nothing", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const parent = await parentUser(fixture.schoolId, "Rana Haddad");
    const linked = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Lina",
      lastName: "Haddad",
    });
    const unlinked = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Omar",
      lastName: "Saleh",
    });
    await link(fixture.schoolId, parent.id, linked.id);

    const response = await preflight(finance, { target_student_ids: [linked.id, unlinked.id] });
    expect(response.status).toBe(200);
    expect((await response.json()) as Preflight).toEqual({
      total_count: 2,
      unlinked_count: 1,
      unlinked_students: [
        { id: unlinked.id, name: "Omar Saleh", admission_number: unlinked.admissionNumber },
      ],
    });

    // The whole school: the fixture's student and Omar have no family, Lina does.
    const all = (await (await preflight(finance, {})).json()) as Preflight;
    expect(all.total_count).toBe(3);
    expect(all.unlinked_count).toBe(2);

    const [batches] = await database!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.invoice_batches WHERE school_id = ${fixture.schoolId}::uuid
    `;
    expect(batches!.count).toBe(0);
  });

  test("a fully linked target reports no unlinked students", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const parent = await parentUser(fixture.schoolId, "Rana Haddad");
    await link(fixture.schoolId, parent.id, fixture.students[0]!.id);

    const response = await preflight(finance, { target_class_ids: [fixture.cls.id] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      total_count: 1,
      unlinked_count: 0,
      unlinked_students: [],
    });
  });

  test("another school's student is refused, and so is a role without billing:read", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);

    const foreign = await preflight(finance, { target_student_ids: [other.students[0]!.id] });
    expect(foreign.status).toBe(400);

    const denied = await preflight(teacherOf(fixture), {});
    expect(denied.status).toBe(403);
  });
});
