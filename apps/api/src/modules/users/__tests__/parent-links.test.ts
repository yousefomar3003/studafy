/**
 * Parent-child linking service tests.
 *
 * Integration tests that require a live PostgreSQL instance. Each test creates its own
 * school, student, and parent data via the test harness factories, then exercises the
 * link/unlink service functions directly within a tenant transaction.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/users/__tests__/parent-links.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createSchool,
  createUser as createUserFactory,
  assignRole,
  createStudent as createStudentFactory,
  integrationEnabled,
  type TestDatabase,
} from "../../../../tests/harness";
import {
  linkParentToStudent,
  unlinkParentFromStudent,
  getStudentGuardians,
} from "../student-service";

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

async function withTx<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const [actor] = await db.sql<{ id: string }[]>`
    SELECT id
    FROM app.users
    WHERE school_id = ${schoolId}
    ORDER BY created_at, id
    LIMIT 1
  `;
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('app.school_id', ${schoolId}, true),
             set_config('app.user_id', ${actor!.id}, true),
             set_config('app.request_id', ${crypto.randomUUID()}, true),
             set_config('statement_timeout', '5000', true)
    `;
    result = await fn(tx);
  });
  return result as T;
}

async function createParentUser(schoolId: string, email?: string) {
  const user = await createUserFactory(db.sql, schoolId, { email });
  await assignRole(db.sql, schoolId, user.id, "PARENT");
  return user;
}

async function expectServiceError(run: () => Promise<unknown>): Promise<void> {
  let received: unknown;
  try {
    await run();
  } catch (error) {
    received = error;
  }
  expect(received).toBeInstanceOf(Error);
}

// ---------------------------------------------------------------------------
// linkParentToStudent
// ---------------------------------------------------------------------------

describeDb("linkParentToStudent", () => {
  test("creates a link and emits audit", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudentFactory(db.sql, school.id, {
      email: "student1@test.local",
    });
    const parent = await createParentUser(school.id, "parent1@test.local");

    const guardian = await withTx(school.id, (tx) =>
      linkParentToStudent(tx, school.id, student.id, parent.id, "mother"),
    );

    expect(guardian).toBeDefined();
    expect(guardian.parent_user_id).toBe(parent.id);
    expect(guardian.relationship).toBe("mother");
    expect(guardian.created_at).toBeInstanceOf(Date);
  });

  test("link is visible via getStudentGuardians", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudentFactory(db.sql, school.id, {
      email: "student2@test.local",
    });
    const parent = await createParentUser(school.id, "parent2@test.local");

    await withTx(school.id, (tx) =>
      linkParentToStudent(tx, school.id, student.id, parent.id, "father"),
    );

    const guardians = await withTx(school.id, (tx) =>
      getStudentGuardians(tx, school.id, student.id),
    );

    expect(guardians.length).toBe(1);
    expect(guardians[0]!.parent_user_id).toBe(parent.id);
    expect(guardians[0]!.relationship).toBe("father");
  });

  test("rejects duplicate link", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudentFactory(db.sql, school.id, {
      email: "student3@test.local",
    });
    const parent = await createParentUser(school.id, "parent3@test.local");

    await withTx(school.id, (tx) =>
      linkParentToStudent(tx, school.id, student.id, parent.id, "guardian"),
    );

    await expectServiceError(() =>
      withTx(school.id, (tx) =>
        linkParentToStudent(tx, school.id, student.id, parent.id, "guardian"),
      ),
    );
  });

  test("rejects non-existent student", async () => {
    const school = await createSchool(db.sql);
    const parent = await createParentUser(school.id, "parent4@test.local");

    await expectServiceError(() =>
      withTx(school.id, (tx) =>
        linkParentToStudent(
          tx,
          school.id,
          "00000000-0000-0000-0000-000000000000",
          parent.id,
          "mother",
        ),
      ),
    );
  });

  test("rejects non-existent parent user", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudentFactory(db.sql, school.id, {
      email: "student5@test.local",
    });

    await expectServiceError(() =>
      withTx(school.id, (tx) =>
        linkParentToStudent(
          tx,
          school.id,
          student.id,
          "00000000-0000-0000-0000-000000000000",
          "mother",
        ),
      ),
    );
  });

  test("rejects user without PARENT role", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudentFactory(db.sql, school.id, {
      email: "student6@test.local",
    });
    const regularUser = await createUserFactory(db.sql, school.id, {
      email: "regular@test.local",
    });

    await expectServiceError(() =>
      withTx(school.id, (tx) =>
        linkParentToStudent(tx, school.id, student.id, regularUser.id, "mother"),
      ),
    );
  });

  test("allows same parent linked to different students", async () => {
    const school = await createSchool(db.sql);
    const student1 = await createStudentFactory(db.sql, school.id, {
      email: "student7a@test.local",
    });
    const student2 = await createStudentFactory(db.sql, school.id, {
      email: "student7b@test.local",
    });
    const parent = await createParentUser(school.id, "parent7@test.local");

    await withTx(school.id, (tx) =>
      linkParentToStudent(tx, school.id, student1.id, parent.id, "mother"),
    );
    await withTx(school.id, (tx) =>
      linkParentToStudent(tx, school.id, student2.id, parent.id, "mother"),
    );

    const guardians1 = await withTx(school.id, (tx) =>
      getStudentGuardians(tx, school.id, student1.id),
    );
    const guardians2 = await withTx(school.id, (tx) =>
      getStudentGuardians(tx, school.id, student2.id),
    );

    expect(guardians1.length).toBe(1);
    expect(guardians2.length).toBe(1);
  });

  test("allows different parents linked to same student", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudentFactory(db.sql, school.id, {
      email: "student8@test.local",
    });
    const parent1 = await createParentUser(school.id, "parent8a@test.local");
    const parent2 = await createParentUser(school.id, "parent8b@test.local");

    await withTx(school.id, (tx) =>
      linkParentToStudent(tx, school.id, student.id, parent1.id, "mother"),
    );
    await withTx(school.id, (tx) =>
      linkParentToStudent(tx, school.id, student.id, parent2.id, "father"),
    );

    const guardians = await withTx(school.id, (tx) =>
      getStudentGuardians(tx, school.id, student.id),
    );
    expect(guardians.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// unlinkParentFromStudent
// ---------------------------------------------------------------------------

describeDb("unlinkParentFromStudent", () => {
  test("removes the link and emits audit", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudentFactory(db.sql, school.id, {
      email: "unlink-student1@test.local",
    });
    const parent = await createParentUser(school.id, "unlink-parent1@test.local");

    await withTx(school.id, (tx) =>
      linkParentToStudent(tx, school.id, student.id, parent.id, "mother"),
    );

    await withTx(school.id, (tx) => unlinkParentFromStudent(tx, school.id, student.id, parent.id));

    const guardians = await withTx(school.id, (tx) =>
      getStudentGuardians(tx, school.id, student.id),
    );
    expect(guardians.length).toBe(0);
  });

  test("rejects unlink when no link exists", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudentFactory(db.sql, school.id, {
      email: "unlink-student2@test.local",
    });
    const parent = await createParentUser(school.id, "unlink-parent2@test.local");

    await expectServiceError(() =>
      withTx(school.id, (tx) => unlinkParentFromStudent(tx, school.id, student.id, parent.id)),
    );
  });

  test("unlink only removes the specified pair", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudentFactory(db.sql, school.id, {
      email: "unlink-student3@test.local",
    });
    const parent1 = await createParentUser(school.id, "unlink-parent3a@test.local");
    const parent2 = await createParentUser(school.id, "unlink-parent3b@test.local");

    await withTx(school.id, (tx) =>
      linkParentToStudent(tx, school.id, student.id, parent1.id, "mother"),
    );
    await withTx(school.id, (tx) =>
      linkParentToStudent(tx, school.id, student.id, parent2.id, "father"),
    );

    await withTx(school.id, (tx) => unlinkParentFromStudent(tx, school.id, student.id, parent1.id));

    const guardians = await withTx(school.id, (tx) =>
      getStudentGuardians(tx, school.id, student.id),
    );
    expect(guardians.length).toBe(1);
    expect(guardians[0]!.parent_user_id).toBe(parent2.id);
  });
});
