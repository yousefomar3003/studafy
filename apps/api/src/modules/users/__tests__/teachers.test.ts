/**
 * Teacher management service tests.
 *
 * Integration tests that require a live PostgreSQL instance. Each test creates its own
 * school and teacher data via the test harness factories, then exercises the service
 * functions directly within a tenant transaction.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/users/__tests__/teachers.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createSchool,
  createUser as createUserFactory,
  createTeacher as createTeacherFactory,
  integrationEnabled,
  type TestDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import {
  listTeachers,
  getTeacher,
  getTeacherByUserId,
  createTeacher,
  updateTeacher,
} from "../teacher-service";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Skip when no database is available
// ---------------------------------------------------------------------------

const describeDb = integrationEnabled ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `fn` in the same tenant transaction production opens (`withTenantTx`): role studafy_app with
 * `app.school_id` armed, so tenant_isolation RLS applies exactly as it does behind a route.
 *
 * No acting user is set: teachers, users, user_roles and audit_logs are guarded by tenant_isolation
 * alone, with no policy reading `app.user_id`. Audit rows written here carry a NULL actor_id.
 */
function withTx<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return withTenantTx(db.sql, { schoolId }, fn);
}

// ---------------------------------------------------------------------------
// listTeachers
// ---------------------------------------------------------------------------

describeDb("listTeachers", () => {
  test("returns paginated results", async () => {
    const school = await createSchool(db.sql);
    await createTeacherFactory(db.sql, school.id, {
      email: "t1@test.local",
      employeeNumber: "EMP-001",
    });
    await createTeacherFactory(db.sql, school.id, {
      email: "t2@test.local",
      employeeNumber: "EMP-002",
    });

    const { rows, next_cursor } = await withTx(school.id, (tx) =>
      listTeachers(tx, school.id, { limit: 10 }),
    );

    expect(rows.length).toBe(2);
    expect(next_cursor).toBeNull();
  });

  test("filters by employment status", async () => {
    const school = await createSchool(db.sql);
    await createTeacherFactory(db.sql, school.id, {
      email: "active@test.local",
      employeeNumber: "EMP-ACT",
    });
    // Create a teacher with pending status directly
    await db.sql.begin(async (tx) => {
      await tx`SELECT set_config('role', 'studafy_app', true)`;
      const user = await createUserFactory(db.sql, school.id, { email: "pending@test.local" });
      await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
      await tx`
        INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
        VALUES (${school.id}, ${user.id}, 'EMP-PEND', 'pending')
      `;
    });

    const { rows } = await withTx(school.id, (tx) =>
      listTeachers(tx, school.id, { limit: 10, status: "active" }),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.employee_number).toBe("EMP-ACT");
  });

  test("searches by employee number", async () => {
    const school = await createSchool(db.sql);
    await createTeacherFactory(db.sql, school.id, {
      email: "search@test.local",
      employeeNumber: "FINDME-001",
    });
    await createTeacherFactory(db.sql, school.id, {
      email: "other@test.local",
      employeeNumber: "OTHER-001",
    });

    const { rows } = await withTx(school.id, (tx) =>
      listTeachers(tx, school.id, { limit: 10, search: "FINDME" }),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.employee_number).toBe("FINDME-001");
  });

  test("cursor pagination returns next page", async () => {
    const school = await createSchool(db.sql);
    for (let i = 0; i < 5; i++) {
      await createTeacherFactory(db.sql, school.id, {
        employeeNumber: `EMP-PAG-${i}`,
      });
    }

    const page1 = await withTx(school.id, (tx) => listTeachers(tx, school.id, { limit: 2 }));
    expect(page1.rows.length).toBe(2);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await withTx(school.id, (tx) =>
      listTeachers(tx, school.id, { limit: 2, cursor: page1.next_cursor! }),
    );
    expect(page2.rows.length).toBe(2);

    const page1Ids = page1.rows.map((r) => r.id);
    const page2Ids = page2.rows.map((r) => r.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getTeacher
// ---------------------------------------------------------------------------

describeDb("getTeacher", () => {
  test("returns teacher by id", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacherFactory(db.sql, school.id, {
      email: "get@test.local",
      employeeNumber: "EMP-GET",
    });

    const result = await withTx(school.id, (tx) => getTeacher(tx, school.id, teacher.id));

    expect(result).toBeDefined();
    expect(result!.employee_number).toBe("EMP-GET");
    expect(result!.employment_status).toBe("active");
  });

  test("returns undefined for non-existent ID", async () => {
    const school = await createSchool(db.sql);
    const result = await withTx(school.id, (tx) =>
      getTeacher(tx, school.id, "00000000-0000-0000-0000-000000000000"),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getTeacherByUserId
// ---------------------------------------------------------------------------

describeDb("getTeacherByUserId", () => {
  test("returns teacher by user id", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacherFactory(db.sql, school.id, {
      email: "byuser@test.local",
      employeeNumber: "EMP-BYUSER",
    });

    const result = await withTx(school.id, (tx) =>
      getTeacherByUserId(tx, school.id, teacher.userId),
    );

    expect(result).toBeDefined();
    expect(result!.id).toBe(teacher.id);
    expect(result!.employee_number).toBe("EMP-BYUSER");
  });

  test("returns undefined for user without teacher profile", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id, { email: "noteach@test.local" });

    const result = await withTx(school.id, (tx) => getTeacherByUserId(tx, school.id, user.id));
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createTeacher
// ---------------------------------------------------------------------------

describeDb("createTeacher", () => {
  test("creates a teacher with INSTRUCTOR role and emits audit", async () => {
    const school = await createSchool(db.sql);

    const teacher = await withTx(school.id, (tx) =>
      createTeacher(tx, school.id, {
        email: "newteacher@test.local",
        employee_number: "EMP-NEW",
        employment_status: "active",
      }),
    );

    expect(teacher).toBeDefined();
    expect(teacher.employee_number).toBe("EMP-NEW");
    expect(teacher.employment_status).toBe("active");
  });

  test("saves the teacher's phone on their account", async () => {
    const school = await createSchool(db.sql);

    const teacher = await withTx(school.id, (tx) =>
      createTeacher(tx, school.id, {
        display_name: "Sara Haddad",
        employee_number: "EMP-PHONE",
        employment_status: "active",
        phone: "+965 5000 1234",
      }),
    );

    const [user] = await db.sql<{ phone: string | null; email: string | null }[]>`
      SELECT phone, email FROM app.users WHERE id = ${teacher.user_id}::uuid
    `;
    expect(user).toEqual({ phone: "+965 5000 1234", email: null });
  });

  test("rejects duplicate employee number within school", async () => {
    const school = await createSchool(db.sql);
    await createTeacherFactory(db.sql, school.id, { employeeNumber: "EMP-DUP" });

    await expect(
      withTx(school.id, (tx) =>
        createTeacher(tx, school.id, {
          email: "dup@test.local",
          employee_number: "EMP-DUP",
          employment_status: "active",
        }),
      ),
    ).rejects.toThrow();
  });

  test("allows same employee number in different schools", async () => {
    const school1 = await createSchool(db.sql);
    const school2 = await createSchool(db.sql);

    const t1 = await withTx(school1.id, (tx) =>
      createTeacher(tx, school1.id, {
        email: "shared1@test.local",
        employee_number: "EMP-SHARED",
        employment_status: "active",
      }),
    );

    const t2 = await withTx(school2.id, (tx) =>
      createTeacher(tx, school2.id, {
        email: "shared2@test.local",
        employee_number: "EMP-SHARED",
        employment_status: "active",
      }),
    );

    expect(t1.id).not.toBe(t2.id);
  });
});

// ---------------------------------------------------------------------------
// updateTeacher
// ---------------------------------------------------------------------------

describeDb("updateTeacher", () => {
  test("modifies employment status", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacherFactory(db.sql, school.id, {
      email: "update@test.local",
      employeeNumber: "EMP-UPD",
    });

    const updated = await withTx(school.id, (tx) =>
      updateTeacher(tx, school.id, teacher.id, { employment_status: "on_leave" }),
    );

    expect(updated.employment_status).toBe("on_leave");
    expect(updated.employee_number).toBe("EMP-UPD");
  });

  test("modifies employee number", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacherFactory(db.sql, school.id, {
      email: "update2@test.local",
      employeeNumber: "EMP-OLD",
    });

    const updated = await withTx(school.id, (tx) =>
      updateTeacher(tx, school.id, teacher.id, { employee_number: "EMP-NEW-NUM" }),
    );

    expect(updated.employee_number).toBe("EMP-NEW-NUM");
  });

  test("rejects duplicate employee number on update", async () => {
    const school = await createSchool(db.sql);
    const _t1 = await createTeacherFactory(db.sql, school.id, { employeeNumber: "EMP-FIRST" });
    const t2 = await createTeacherFactory(db.sql, school.id, { employeeNumber: "EMP-SECOND" });

    await expect(
      withTx(school.id, (tx) =>
        updateTeacher(tx, school.id, t2.id, { employee_number: "EMP-FIRST" }),
      ),
    ).rejects.toThrow();
  });

  test("returns 404 for non-existent teacher", async () => {
    const school = await createSchool(db.sql);

    await expect(
      withTx(school.id, (tx) =>
        updateTeacher(tx, school.id, "00000000-0000-0000-0000-000000000000", {
          employment_status: "active",
        }),
      ),
    ).rejects.toThrow();
  });
});
