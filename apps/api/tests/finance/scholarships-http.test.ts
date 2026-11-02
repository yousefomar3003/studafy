/**
 * Scholarship HTTP tests (000149): finance defines scholarships and requests awards; only the school
 * admin (billing:approveScholarship) approves, rejects or revokes them. Full HTTP path — JWT auth,
 * permission gates, a real tenant transaction with RLS armed. Requires a live PostgreSQL instance,
 * gated on TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/finance/scholarships-http.test.ts
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

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
}

interface Scholarship {
  id: string;
  name: string;
  discount_type: string;
  percentage: string | null;
  amount: string | null;
  currency: string | null;
  fee_category: string | null;
  is_active: boolean;
  approved_award_count: number;
}

interface Award {
  id: string;
  status: string;
  student_id: string;
  student_name: string;
  admission_number: string;
  scholarship_name: string;
  requested_by: string;
  decided_by: string | null;
  decision_notes: string | null;
}

async function financeOf(fixture: TenantFixture): Promise<Actor> {
  const user = await createUser(database!.sql, fixture.schoolId, {
    email: `finance-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.FINANCE);
  return { schoolId: fixture.schoolId, userId: user.id, roles: [ROLES.FINANCE] };
}

function adminOf(fixture: TenantFixture): Actor {
  return {
    schoolId: fixture.schoolId,
    userId: fixture.users.ORG_ADMIN.id,
    roles: [ROLES.ORG_ADMIN],
  };
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

async function createScholarship(actor: Actor, body: Record<string, unknown>) {
  const response = await request(actor, "POST", "/api/finance/scholarships", body);
  expect(response.status).toBe(201);
  return (await response.json()) as Scholarship;
}

async function requestAward(actor: Actor, scholarshipId: string, studentId: string) {
  const response = await request(actor, "POST", "/api/finance/scholarship-awards", {
    scholarship_id: scholarshipId,
    student_id: studentId,
    notes: "Sibling enrolled",
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Award;
}

describeDb("scholarships HTTP", () => {
  test("finance requests an award and only the school admin approves it", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const admin = adminOf(fixture);
    const student = fixture.students[0]!;

    const sibling = await createScholarship(finance, {
      name: "Sibling discount",
      discount_type: "percentage",
      percentage: 10,
    });
    expect(sibling).toMatchObject({
      discount_type: "percentage",
      percentage: "10.00",
      amount: null,
      fee_category: null,
      is_active: true,
      approved_award_count: 0,
    });

    // Finance cannot read student records, but can find and name the student it awards.
    const search = await request(finance, "GET", "/api/finance/students");
    expect(search.status).toBe(200);
    const { students } = (await search.json()) as { students: { id: string }[] };
    expect(students.map((s) => s.id)).toContain(student.id);

    const award = await requestAward(finance, sibling.id, student.id);
    expect(award).toMatchObject({
      status: "pending_approval",
      student_id: student.id,
      admission_number: student.admissionNumber,
      scholarship_name: "Sibling discount",
      requested_by: finance.userId,
      decided_by: null,
    });
    expect(award.student_name.length).toBeGreaterThan(0);

    const financeApproves = await request(
      finance,
      "POST",
      `/api/finance/scholarship-awards/${award.id}/approve`,
      {},
    );
    expect(financeApproves.status).toBe(403);

    const approved = await request(
      admin,
      "POST",
      `/api/finance/scholarship-awards/${award.id}/approve`,
      {},
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "approved", decided_by: admin.userId });

    const list = await request(finance, "GET", "/api/finance/scholarship-awards?status=approved");
    expect(list.status).toBe(200);
    const { awards } = (await list.json()) as { awards: Award[] };
    expect(awards.map((a) => a.id)).toEqual([award.id]);

    const scholarships = await request(finance, "GET", "/api/finance/scholarships");
    const listed = (await scholarships.json()) as { scholarships: Scholarship[] };
    expect(listed.scholarships[0]!.approved_award_count).toBe(1);

    const [audit] = await database!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.audit_logs
      WHERE school_id = ${fixture.schoolId}::uuid AND target_table = 'scholarship_awards'
    `;
    expect(audit!.count).toBe(2);
  });

  test("a student holds a scholarship once at a time; revoked awards can be requested again", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const admin = adminOf(fixture);
    const student = fixture.students[0]!;
    const merit = await createScholarship(finance, {
      name: "Merit",
      discount_type: "fixed",
      amount: 150.5,
      currency: "JOD",
      fee_category: "Tuition",
    });
    expect(merit).toMatchObject({ amount: "150.500", currency: "JOD", fee_category: "Tuition" });

    const first = await requestAward(finance, merit.id, student.id);
    const duplicate = await request(finance, "POST", "/api/finance/scholarship-awards", {
      scholarship_id: merit.id,
      student_id: student.id,
    });
    expect(duplicate.status).toBe(409);

    await request(admin, "POST", `/api/finance/scholarship-awards/${first.id}/approve`, {});
    const revoked = await request(
      admin,
      "POST",
      `/api/finance/scholarship-awards/${first.id}/revoke`,
      { notes: "Grades dropped" },
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      status: "revoked",
      decision_notes: "Grades dropped",
    });

    // Revoking twice is not a valid transition.
    const again = await request(
      admin,
      "POST",
      `/api/finance/scholarship-awards/${first.id}/revoke`,
      {},
    );
    expect(again.status).toBe(409);

    await requestAward(finance, merit.id, student.id);
  });

  test("rejecting needs a reason, and an inactive scholarship cannot be awarded", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const admin = adminOf(fixture);
    const scholarship = await createScholarship(finance, {
      name: "Hardship",
      discount_type: "percentage",
      percentage: 50,
    });
    const award = await requestAward(finance, scholarship.id, fixture.students[0]!.id);

    const noReason = await request(
      admin,
      "POST",
      `/api/finance/scholarship-awards/${award.id}/reject`,
      {},
    );
    expect(noReason.status).toBe(400);
    const rejected = await request(
      admin,
      "POST",
      `/api/finance/scholarship-awards/${award.id}/reject`,
      { notes: "Household income above threshold" },
    );
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ status: "rejected" });

    const deactivated = await request(
      finance,
      "PATCH",
      `/api/finance/scholarships/${scholarship.id}`,
      { is_active: false },
    );
    expect(deactivated.status).toBe(200);
    const inactive = await request(finance, "POST", "/api/finance/scholarship-awards", {
      scholarship_id: scholarship.id,
      student_id: fixture.students[0]!.id,
    });
    expect(inactive.status).toBe(409);
  });

  test("validation: a scholarship's value matches its type, and names are unique", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);

    const missingPercentage = await request(finance, "POST", "/api/finance/scholarships", {
      name: "Broken",
      discount_type: "percentage",
    });
    expect(missingPercentage.status).toBe(400);
    const tooMuch = await request(finance, "POST", "/api/finance/scholarships", {
      name: "Broken",
      discount_type: "percentage",
      percentage: 120,
    });
    expect(tooMuch.status).toBe(400);
    const fixedWithoutCurrency = await request(finance, "POST", "/api/finance/scholarships", {
      name: "Broken",
      discount_type: "fixed",
      amount: 10,
    });
    expect(fixedWithoutCurrency.status).toBe(400);

    await createScholarship(finance, {
      name: "Staff child",
      discount_type: "percentage",
      percentage: 25,
    });
    const taken = await request(finance, "POST", "/api/finance/scholarships", {
      name: "Staff child",
      discount_type: "percentage",
      percentage: 30,
    });
    expect(taken.status).toBe(409);
  });

  test("another school's admin can neither see nor decide an award", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const scholarship = await createScholarship(finance, {
      name: "Sibling discount",
      discount_type: "percentage",
      percentage: 10,
    });
    const award = await requestAward(finance, scholarship.id, fixture.students[0]!.id);

    const outsider = adminOf(other);
    const list = await request(outsider, "GET", "/api/finance/scholarship-awards");
    expect(((await list.json()) as { awards: Award[] }).awards).toEqual([]);
    const search = await request(outsider, "GET", "/api/finance/students");
    const seen = ((await search.json()) as { students: { id: string }[] }).students;
    expect(seen.some((s) => s.id === fixture.students[0]!.id)).toBe(false);
    const decide = await request(
      outsider,
      "POST",
      `/api/finance/scholarship-awards/${award.id}/approve`,
      {},
    );
    expect(decide.status).toBe(404);
  });

  test("teachers and parents have no access", async () => {
    const fixture = await createFullTenant(database!.sql);
    for (const role of [ROLES.INSTRUCTOR, ROLES.PARENT] as const) {
      const actor = { schoolId: fixture.schoolId, userId: fixture.users[role].id, roles: [role] };
      const response = await request(actor, "GET", "/api/finance/scholarships");
      expect(response.status).toBe(403);
    }
  });
});
