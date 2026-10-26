/**
 * The students a fee structure is for (000150): finance sets and reads the list, even though it
 * cannot read student records, and the list stays inside the school. Requires a live PostgreSQL
 * instance, gated on TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/finance/fee-structure-students-http.test.ts
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
const STRUCTURE = "FS-2026-0001";
const PATH = `/api/finance/fee-structures/${STRUCTURE}/students`;

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

async function financeOf(fixture: TenantFixture): Promise<Actor> {
  const user = await createUser(database!.sql, fixture.schoolId, {
    email: `finance-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.FINANCE);
  return { schoolId: fixture.schoolId, userId: user.id, roles: [ROLES.FINANCE] };
}

async function seedStructure(schoolId: string) {
  await database!.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.fee_structure_cache (
        school_id, currency_id, erpnext_docname, erpnext_status, title, total_amount_minor,
        last_synced_at
      )
      SELECT ${schoolId}::uuid, id, ${STRUCTURE}, 'draft', 'Grade 5 Fees', 1000000, now()
      FROM app.currencies WHERE code = 'JOD'
    `;
  });
}

function put(actor: Actor, studentIds: string[]) {
  return authenticatedRequest(harness!, "PUT", PATH, actor, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ student_ids: studentIds }),
  });
}

describeDb("fee structure students", () => {
  test("finance sets, reads, and clears a structure's students", async () => {
    const fixture = await createFullTenant(database!.sql);
    await seedStructure(fixture.schoolId);
    const finance = await financeOf(fixture);
    const first = fixture.students[0]!;
    const second = await createStudent(database!.sql, fixture.schoolId);

    const empty = await authenticatedRequest(harness!, "GET", PATH, finance);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { students: unknown[] }).students).toEqual([]);

    const saved = await put(finance, [first.id, second.id, first.id]);
    if (saved.status !== 200) console.log("DEBUG", await saved.clone().text());
    expect(saved.status).toBe(200);
    const { students } = (await saved.json()) as {
      students: { id: string; name: string; admission_number: string }[];
    };
    expect(students.map((s) => s.id).sort()).toEqual([first.id, second.id].sort());
    expect(students.every((s) => s.name.length > 0)).toBe(true);

    const read = await authenticatedRequest(harness!, "GET", PATH, finance);
    expect(((await read.json()) as { students: unknown[] }).students).toHaveLength(2);

    const cleared = await put(finance, []);
    expect(((await cleared.json()) as { students: unknown[] }).students).toEqual([]);
  });

  test("another school's student and an unknown structure are refused", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    await seedStructure(fixture.schoolId);
    const finance = await financeOf(fixture);

    const foreign = await put(finance, [other.students[0]!.id]);
    expect(foreign.status).toBe(400);

    const missing = await authenticatedRequest(
      harness!,
      "PUT",
      "/api/finance/fee-structures/FS-NOPE/students",
      finance,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ student_ids: [fixture.students[0]!.id] }),
      },
    );
    expect(missing.status).toBe(404);
  });
});
