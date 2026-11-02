/**
 * Invoice batch targets: who a batch bills. A FINANCE user cannot see app.students under its
 * role-scope policy, so target resolution runs through the finance identity read
 * (modules/finance/students/service.ts) — these tests pin that finance can bill the whole school or
 * hand-picked students, and that picking is exact. Requires a live PostgreSQL instance, gated on
 * TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/finance/invoice-batch-targets-http.test.ts
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

async function financeOf(fixture: TenantFixture): Promise<Actor> {
  const user = await createUser(database!.sql, fixture.schoolId, {
    email: `finance-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.FINANCE);
  return { schoolId: fixture.schoolId, userId: user.id, roles: [ROLES.FINANCE] };
}

function createBatch(actor: Actor, target: Record<string, unknown>) {
  return authenticatedRequest(harness!, "POST", "/api/finance/invoices/batches", actor, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fee_structure_erpnext_name: "FS-2026-0001",
      period_title: "Term 1",
      ...target,
    }),
  });
}

describeDb("invoice batch targets", () => {
  test("finance bills the whole school", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);

    const response = await createBatch(finance, {});
    expect(response.status).toBe(201);
    expect(((await response.json()) as { total_count: number }).total_count).toBe(
      fixture.students.length,
    );
  });

  test("finance bills exactly the students it picked", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const picked = fixture.students[0]!;

    const response = await createBatch(finance, { target_student_ids: [picked.id, picked.id] });
    expect(response.status).toBe(201);
    const batch = (await response.json()) as { id: string; total_count: number };
    expect(batch.total_count).toBe(1);

    const items = await database!.sql<{ student_id: string }[]>`
      SELECT student_id FROM app.invoice_batch_items WHERE batch_id = ${batch.id}::uuid
    `;
    expect(items.map((i) => i.student_id)).toEqual([picked.id]);
  });

  test("a picked student from another school, or a mixed target, is refused", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);

    const foreign = await createBatch(finance, {
      target_student_ids: [fixture.students[0]!.id, other.students[0]!.id],
    });
    expect(foreign.status).toBe(400);

    const mixed = await createBatch(finance, {
      target_student_ids: [fixture.students[0]!.id],
      target_class_ids: [fixture.cls.id],
    });
    expect(mixed.status).toBe(400);
  });

  test("finance lists its school's students and filters them by name", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const lina = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Lina",
      lastName: "Haddad",
    });
    const list = async (query: string) => {
      const response = await authenticatedRequest(
        harness!,
        "GET",
        `/api/finance/students${query}`,
        finance,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { students: { id: string; name: string }[] }).students;
    };

    // No search: the whole list to pick from, this school only.
    const all = await list("");
    expect(all.map((s) => s.id).sort()).toEqual(
      [...fixture.students.map((s) => s.id), lina.id].sort(),
    );
    expect(all.some((s) => s.id === other.students[0]!.id)).toBe(false);

    // A name filters it; an admission number does not match.
    expect((await list("?search=lin")).map((s) => s.name)).toEqual(["Lina Haddad"]);
    expect(await list(`?search=${encodeURIComponent(lina.admissionNumber)}`)).toEqual([]);

    const teacher = {
      schoolId: fixture.schoolId,
      userId: fixture.users.INSTRUCTOR.id,
      roles: [ROLES.INSTRUCTOR],
    };
    const denied = await authenticatedRequest(harness!, "GET", "/api/finance/students", teacher);
    expect(denied.status).toBe(403);
  });
});
