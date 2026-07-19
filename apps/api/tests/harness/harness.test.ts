// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  authenticatedRequest,
  createFullTenant,
  createSchool,
  createStudent,
  createTeacher,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from ".";

import type { TestApp, TestDatabase } from ".";
import type { TenantFixture } from "./factories";

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture | undefined;

describe("integration test harness", () => {
  beforeAll(async () => {
    if (!integrationEnabled) return;

    database = await createTestDatabase();
    await migrateDatabase(database.url);
    tenant = await createFullTenant(database.sql);
    const created = createTestApp({ database: database.sql });
    await created.ready;
    harness = created;
  }, 60_000);

  afterAll(async () => {
    harness?.keyStore.destroy();
    await database?.cleanup();
  });

  integrationTest("health check returns 200", async () => {
    const res = await harness!.app.request("/healthz");
    expect(res.status).toBe(200);
  });

  integrationTest("ready check returns 200", async () => {
    const res = await harness!.app.request("/readyz");
    expect(res.status).toBe(200);
  });

  integrationTest("createFullTenant provisions all 7 roles", async () => {
    const roles = [
      "SUPER_ADMIN",
      "ORG_ADMIN",
      "INSTRUCTOR",
      "TEACHING_ASSISTANT",
      "STUDENT",
      "GUEST",
      "SUPPORT_AGENT",
    ] as const;

    for (const role of roles) {
      expect(tenant!.users[role]).toBeDefined();
      expect(tenant!.users[role].id).toBeTruthy();
      expect(tenant!.users[role].email).toContain(role.toLowerCase().replace(/_/g, "-"));
    }
  });

  integrationTest("createFullTenant provisions academic structure", async () => {
    expect(tenant!.academicYear.id).toBeTruthy();
    expect(tenant!.term.id).toBeTruthy();
    expect(tenant!.subject.id).toBeTruthy();
    expect(tenant!.course.id).toBeTruthy();
    expect(tenant!.room.id).toBeTruthy();
    expect(tenant!.cls.id).toBeTruthy();
  });

  integrationTest("createFullTenant provisions student and teacher", async () => {
    expect(tenant!.students).toHaveLength(1);
    expect(tenant!.students[0].id).toBeTruthy();
    expect(tenant!.teachers).toHaveLength(1);
    expect(tenant!.teachers[0].id).toBeTruthy();
  });

  integrationTest("authenticated request injects school/user context", async () => {
    const res = await authenticatedRequest(harness!, "GET", "/healthz", {
      schoolId: tenant!.schoolId,
      userId: tenant!.users.ORG_ADMIN.id,
    });
    expect(res.status).toBe(200);
  });

  integrationTest("factories create isolated tenants", async () => {
    const secondSchool = await createSchool(database!.sql, { slug: "second-tenant" });
    expect(secondSchool.id).not.toBe(tenant!.schoolId);

    const student = await createStudent(database!.sql, secondSchool.id, {
      firstName: "Second",
      lastName: "Tenant",
    });
    expect(student.id).toBeTruthy();
    expect(student.userId).toBeTruthy();

    const teacher = await createTeacher(database!.sql, secondSchool.id);
    expect(teacher.id).toBeTruthy();
    expect(teacher.userId).not.toBe(student.userId);

    const schools = await database!.sql`SELECT id FROM app.schools`;
    expect(schools.length).toBeGreaterThanOrEqual(2);
  });
});
