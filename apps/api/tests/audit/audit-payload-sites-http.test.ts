/**
 * Every write below used to answer 500: its audit row was an "update" or "delete" with no
 * before-values, which ck_audit_logs_payload rejects, so the whole transaction rolled back. Each
 * call site now passes the prior row (and auditEmitter's auditPayload backstops any that can't).
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/audit/audit-payload-sites-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  authenticatedRequest,
  createFullTenant,
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

function asAdmin(tenant: TenantFixture, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id, roles: [ROLES.ORG_ADMIN] },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

async function auditOldValues(
  schoolId: string,
  table: string,
  targetId: string,
  action: "update" | "delete",
): Promise<Record<string, unknown>> {
  const [row] = await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ old_values: Record<string, unknown> }[]>`
      SELECT old_values FROM app.audit_logs
      WHERE school_id = ${schoolId}::uuid AND target_table = ${table}
        AND target_id = ${targetId}::uuid AND action = ${action}::app.audit_action
      ORDER BY created_at DESC LIMIT 1
    `;
  });
  return row!.old_values;
}

describeDb("writes whose audit rows used to fail", () => {
  test("grade level and section: rename, then delete", async () => {
    const tenant = await createFullTenant(database!.sql);

    const level = await asAdmin(tenant, "POST", "/api/academics/grade-levels", {
      name: "grrade 12",
      sort_order: 12,
    });
    expect(level.status).toBe(201);
    const { id: levelId } = (await level.json()) as { id: string };
    const renamedLevel = await asAdmin(tenant, "PATCH", `/api/academics/grade-levels/${levelId}`, {
      name: "Grade 12",
    });
    expect(renamedLevel.status).toBe(200);
    expect(await auditOldValues(tenant.schoolId, "grade_levels", levelId, "update")).toMatchObject({
      name: "grrade 12",
    });

    const section = await asAdmin(tenant, "POST", "/api/academics/sections", {
      academic_year_id: tenant.academicYear.id,
      grade_level_id: levelId,
      name: "AA",
    });
    expect(section.status).toBe(201);
    const { id: sectionId } = (await section.json()) as { id: string };
    const renamed = await asAdmin(tenant, "PATCH", `/api/academics/sections/${sectionId}`, {
      name: "A",
    });
    expect(renamed.status).toBe(200);
    expect(await auditOldValues(tenant.schoolId, "sections", sectionId, "update")).toMatchObject({
      name: "AA",
    });

    const removedSection = await asAdmin(tenant, "DELETE", `/api/academics/sections/${sectionId}`);
    expect(removedSection.status).toBeLessThan(300);
    expect(await auditOldValues(tenant.schoolId, "sections", sectionId, "delete")).toMatchObject({
      name: "A",
    });

    const removedLevel = await asAdmin(tenant, "DELETE", `/api/academics/grade-levels/${levelId}`);
    expect(removedLevel.status).toBeLessThan(300);
    expect(await auditOldValues(tenant.schoolId, "grade_levels", levelId, "delete")).toMatchObject({
      name: "Grade 12",
    });
  });

  test("a class with no enrolments is deleted", async () => {
    const tenant = await createFullTenant(database!.sql);
    const created = await asAdmin(tenant, "POST", "/api/academics/classes", {
      course_id: tenant.course.id,
      academic_year_id: tenant.academicYear.id,
      term_id: tenant.term.id,
      lead_teacher_id: tenant.teachers[0]!.id,
      code: `HIST-${crypto.randomUUID().slice(0, 6)}`,
    });
    expect(created.status).toBe(201);
    const { id: classId, code } = (await created.json()) as { id: string; code: string };

    const removed = await asAdmin(tenant, "DELETE", `/api/academics/classes/${classId}`);
    expect(removed.status).toBeLessThan(300);
    expect(await auditOldValues(tenant.schoolId, "classes", classId, "delete")).toMatchObject({
      code,
    });
  });

  test("a student is transferred, then re-enrolled in the class they left", async () => {
    const tenant = await createFullTenant(database!.sql);
    const studentId = tenant.students[0]!.id;
    const other = await asAdmin(tenant, "POST", "/api/academics/classes", {
      course_id: tenant.course.id,
      academic_year_id: tenant.academicYear.id,
      term_id: tenant.term.id,
      lead_teacher_id: tenant.teachers[0]!.id,
      code: `MATH-${crypto.randomUUID().slice(0, 6)}`,
    });
    expect(other.status).toBe(201);
    const { id: otherId } = (await other.json()) as { id: string };

    // Make sure the student is enrolled in the fixture class first.
    const enrolled = await asAdmin(
      tenant,
      "POST",
      `/api/academics/classes/${tenant.cls.id}/enrollments`,
      { student_id: studentId },
    );
    expect([201, 409]).toContain(enrolled.status);

    const moved = await asAdmin(
      tenant,
      "POST",
      `/api/academics/classes/${tenant.cls.id}/enrollments/transfer`,
      { student_id: studentId, to_class_id: otherId },
    );
    expect(moved.status).toBeLessThan(300);

    const back = await asAdmin(
      tenant,
      "POST",
      `/api/academics/classes/${tenant.cls.id}/enrollments`,
      { student_id: studentId },
    );
    expect(back.status).toBe(201);
    expect(
      await auditOldValues(tenant.schoolId, "enrollments", tenant.cls.id, "update"),
    ).toMatchObject({ student_id: studentId, status: "withdrawn" });
  });
});
