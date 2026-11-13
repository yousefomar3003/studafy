/**
 * getStudentSelfByUserId — the service behind GET /api/students/me.
 *
 * Integration tests that require a live PostgreSQL instance. Each test builds its own tenant via
 * the harness factories and runs the service inside a real tenant transaction (withTenantTx), so
 * the role_scope_visibility RLS policies apply exactly as they do for the route.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/users/__tests__/student-self.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createFullTenant,
  createClass,
  createEnrollment,
  createStudent,
  createUser as createUserFactory,
  integrationEnabled,
  type TenantFixture,
  type TestDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { getStudentSelfByUserId } from "../student-service";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

function resolveSelf(tenant: TenantFixture, userId: string) {
  return withTenantTx(db.sql, { schoolId: tenant.schoolId, userId }, (tx) =>
    getStudentSelfByUserId(tx, tenant.schoolId, userId),
  );
}

async function addClass(tenant: TenantFixture, code: string): Promise<string> {
  const cls = await createClass(db.sql, tenant.schoolId, {
    courseId: tenant.course.id,
    academicYearId: tenant.academicYear.id,
    termId: tenant.term.id,
    leadTeacherId: tenant.teachers[0]!.id,
    roomId: tenant.room.id,
    code,
  });
  return cls.id;
}

describeDb("getStudentSelfByUserId", () => {
  test("returns the caller's own student record and active enrolled class ids", async () => {
    const tenant = await createFullTenant(db.sql);
    const student = tenant.students[0]!;

    const result = await resolveSelf(tenant, student.userId);

    expect(result).toBeDefined();
    expect(result!.id).toBe(student.id);
    expect(result!.user_id).toBe(student.userId);
    expect(result!.first_name).toBe("Primary");
    expect(result!.enrolled_class_ids).toEqual([tenant.cls.id]);
  });

  test("excludes withdrawn enrollments and non-active classes", async () => {
    const tenant = await createFullTenant(db.sql);
    const student = tenant.students[0]!;
    const withdrawnClassId = await addClass(tenant, `WD-${tenant.schoolSlug}`);
    const completedClassId = await addClass(tenant, `CP-${tenant.schoolSlug}`);
    await createEnrollment(db.sql, tenant.schoolId, withdrawnClassId, student.id);
    await createEnrollment(db.sql, tenant.schoolId, completedClassId, student.id);

    await db.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
      await tx`
        UPDATE app.enrollments SET status = 'withdrawn', withdrawn_at = now()
        WHERE school_id = ${tenant.schoolId} AND class_id = ${withdrawnClassId}
      `;
      await tx`
        UPDATE app.classes SET status = 'completed'
        WHERE school_id = ${tenant.schoolId} AND id = ${completedClassId}
      `;
    });

    const result = await resolveSelf(tenant, student.userId);
    expect(result!.enrolled_class_ids).toEqual([tenant.cls.id]);
  });

  test("returns sorted ids when enrolled in several classes", async () => {
    const tenant = await createFullTenant(db.sql);
    const student = tenant.students[0]!;
    const secondClassId = await addClass(tenant, `C2-${tenant.schoolSlug}`);
    await createEnrollment(db.sql, tenant.schoolId, secondClassId, student.id);

    const result = await resolveSelf(tenant, student.userId);
    expect(result!.enrolled_class_ids).toEqual([tenant.cls.id, secondClassId].sort());
  });

  test("never returns another student's enrollments", async () => {
    const tenant = await createFullTenant(db.sql);
    const other = await createStudent(db.sql, tenant.schoolId, {
      email: `other@test-${tenant.schoolSlug}.local`,
    });

    const result = await resolveSelf(tenant, other.userId);
    expect(result!.id).toBe(other.id);
    expect(result!.enrolled_class_ids).toEqual([]);
  });

  test("returns undefined for a user without a student record", async () => {
    const tenant = await createFullTenant(db.sql);
    const user = await createUserFactory(db.sql, tenant.schoolId, {
      email: `nostudent@test-${tenant.schoolSlug}.local`,
    });

    expect(await resolveSelf(tenant, user.id)).toBeUndefined();
    expect(await resolveSelf(tenant, tenant.teachers[0]!.userId)).toBeUndefined();
  });

  test("does not resolve a student from another school", async () => {
    const tenantA = await createFullTenant(db.sql);
    const tenantB = await createFullTenant(db.sql);

    const result = await resolveSelf(tenantB, tenantA.students[0]!.userId);
    expect(result).toBeUndefined();
  });
});
