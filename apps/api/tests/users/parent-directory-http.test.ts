/**
 * The parent directory over HTTP (`GET /api/parents`, `GET /api/parents/{parentUserId}`): a
 * principal sees each parent's contact details, Studafy ID and children with their class; a teacher
 * (who can read records, but not users) is refused.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AUTH_CHANNELS } from "../../src/modules/auth";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createStudent,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase } from "../harness";
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
}, 120_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

interface Seeded {
  schoolId: string;
  principalId: string;
  parentId: string;
  studentId: string;
}

async function seed(): Promise<Seeded> {
  const sql = database!.sql;
  const school = await createSchool(sql);
  const principal = await createUser(sql, school.id);
  await assignRole(sql, school.id, principal.id, "PRINCIPAL");
  const parent = await createUser(sql, school.id, { displayName: "Mona Hassan" });
  await assignRole(sql, school.id, parent.id, "PARENT");
  const student = await createStudent(sql, school.id, {
    firstName: "Ali",
    lastName: "Hassan",
    admissionNumber: "ADM-1",
  });
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
    await tx`UPDATE app.users SET phone = '+965 5000 1234' WHERE id = ${parent.id}::uuid`;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${school.id}::uuid, 'Hassan', ${parent.id}::uuid) RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links
        (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${school.id}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${student.id}::uuid,
              'mother')
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${school.id}::uuid, 'Y1', 'Year 1', CURRENT_DATE - 30, CURRENT_DATE + 300, 'active')
      RETURNING id
    `;
    const [grade] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_levels (school_id, name, sort_order)
      VALUES (${school.id}::uuid, 'Grade 1', 1) RETURNING id
    `;
    const [section] = await tx<{ id: string }[]>`
      INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
      VALUES (${school.id}::uuid, ${year!.id}::uuid, ${grade!.id}::uuid, 'A') RETURNING id
    `;
    await tx`
      INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
      VALUES (${school.id}::uuid, ${student.id}::uuid, ${year!.id}::uuid, ${section!.id}::uuid)
    `;
  });
  return {
    schoolId: school.id,
    principalId: principal.id,
    parentId: parent.id,
    studentId: student.id,
  };
}

function get(seeded: Seeded, path: string, roles: Role[] = ["PRINCIPAL"]) {
  return authenticatedRequest(harness!, "GET", path, {
    schoolId: seeded.schoolId,
    userId: seeded.principalId,
    channel: AUTH_CHANNELS.WEB,
    roles,
  });
}

describeDb("parent directory", () => {
  test("a principal sees each parent's contact details, ID and children with their class", async () => {
    const seeded = await seed();

    const list = await get(seeded, "/api/parents");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { parents: Record<string, unknown>[] };
    expect(body.parents).toHaveLength(1);
    expect(body.parents[0]).toMatchObject({
      user_id: seeded.parentId,
      display_name: "Mona Hassan",
      phone: "+965 5000 1234",
      status: "active",
      children: [
        {
          student_id: seeded.studentId,
          first_name: "Ali",
          last_name: "Hassan",
          // Finance-visible only, as on the student list: a principal sees none.
          admission_number: null,
          relationship: "mother",
          class_label: "Grade 1 – A",
        },
      ],
    });
    expect(String(body.parents[0]!.member_code)).toStartWith("PAR-");

    const one = await get(seeded, `/api/parents/${seeded.parentId}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ user_id: seeded.parentId, phone: "+965 5000 1234" });
  });

  test("search narrows by name; a non-parent is 404", async () => {
    const seeded = await seed();
    const hit = (await (await get(seeded, "/api/parents?search=mona")).json()) as {
      parents: unknown[];
    };
    expect(hit.parents).toHaveLength(1);
    const miss = (await (await get(seeded, "/api/parents?search=zzz")).json()) as {
      parents: unknown[];
    };
    expect(miss.parents).toHaveLength(0);
    expect((await get(seeded, `/api/parents/${seeded.principalId}`)).status).toBe(404);
  });

  test("a teacher cannot read the parent directory", async () => {
    const seeded = await seed();
    expect((await get(seeded, "/api/parents", ["INSTRUCTOR"])).status).toBe(403);
    expect((await get(seeded, `/api/parents/${seeded.parentId}`, ["INSTRUCTOR"])).status).toBe(403);
  });
});
