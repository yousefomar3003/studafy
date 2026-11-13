// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  createSchool,
  createStudent,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../tests/harness";

import {
  createFamily,
  createFamilyLink,
  deleteFamily,
  deleteFamilyLink,
  getFamily,
  listFamilies,
  updateFamilyLink,
} from "./service";

import type { TransactionSql } from "postgres";

const describeDatabase = integrationEnabled ? describe : describe.skip;
let database: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase({ maxConnections: 16 });
  await migrateDatabase(database.url);
});

afterAll(async () => {
  await database?.cleanup();
});

async function tenantTx<T>(
  schoolId: string,
  userId: string,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${schoolId}, true),
             set_config('app.user_id', ${userId}, true),
             set_config('app.request_id', ${crypto.randomUUID()}, true),
             set_config('statement_timeout', '5000', true)
    `;
    result = await run(tx);
  });
  return result as T;
}

describeDatabase("family household lifecycle", () => {
  test("creates, reads, moves, unlinks, and safely deletes family links", async () => {
    const school = await createSchool(database.sql);
    const administrator = await createUser(database.sql, school.id);
    await assignRole(database.sql, school.id, administrator.id, "ORG_ADMIN");
    const parent = await createUser(database.sql, school.id, { displayName: "Parent One" });
    await assignRole(database.sql, school.id, parent.id, "PARENT");
    const student = await createStudent(database.sql, school.id);

    const first = await tenantTx(school.id, administrator.id, (tx) =>
      createFamily(tx, school.id, "Household One", parent.id),
    );
    const second = await tenantTx(school.id, administrator.id, (tx) =>
      createFamily(tx, school.id, "Household Two", parent.id),
    );
    const link = await tenantTx(school.id, administrator.id, (tx) =>
      createFamilyLink(tx, school.id, first.id, parent.id, student.id, "guardian"),
    );
    expect(link.family_id).toBe(first.id);

    const parentList = await tenantTx(school.id, parent.id, (tx) =>
      listFamilies(tx, school.id, parent.id, false, { limit: 20, offset: 0 }),
    );
    expect(parentList.rows.map((family) => family.id).sort()).toEqual([first.id, second.id].sort());

    const deleteStatus = await tenantTx(school.id, administrator.id, async (tx) => {
      try {
        await deleteFamily(tx, school.id, first.id);
        return 204;
      } catch (error) {
        return (error as { status?: number }).status;
      }
    });
    expect(deleteStatus).toBe(409);

    const moved = await tenantTx(school.id, administrator.id, (tx) =>
      updateFamilyLink(tx, school.id, first.id, parent.id, student.id, {
        targetFamilyId: second.id,
        relationship: "father",
      }),
    );
    expect(moved).toMatchObject({ family_id: second.id, relationship: "father" });
    expect(
      await tenantTx(school.id, parent.id, (tx) =>
        getFamily(tx, school.id, second.id, parent.id, false),
      ),
    ).not.toBeNull();

    await tenantTx(school.id, administrator.id, (tx) =>
      deleteFamilyLink(tx, school.id, second.id, parent.id, student.id),
    );
    await tenantTx(school.id, administrator.id, (tx) => deleteFamily(tx, school.id, first.id));
  });
});
