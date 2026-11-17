/**
 * QA-031: grades.published names its recipients -- the student's own account and their linked
 * guardians -- so the realtime gateway can deliver it to them alone instead of every student and
 * parent socket in the school.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/grades/grade-recipients.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import { gradeRecipients } from "../../src/modules/grades/grade-recipients";
import {
  appDatabaseFor,
  createFullTenant,
  createStudent,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestDatabase, TenantFixture } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let tenant: TenantFixture;
let otherStudentId: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
  otherStudentId = (await createStudent(database.sql, tenant.schoolId)).id;
  const parentId = tenant.users[ROLES.PARENT]!.id;
  await database.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Family', ${parentId}::uuid) RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parentId}::uuid,
              ${tenant.students[0]!.id}::uuid, 'guardian')
    `;
  });
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describeDb("grades.published recipients (QA-031)", () => {
  test("the student's account and linked guardian, and nobody else's", async () => {
    const recipients = await withTenantTx(
      appDatabaseFor(database!.sql),
      { schoolId: tenant.schoolId, userId: tenant.users[ROLES.ORG_ADMIN]!.id },
      (tx) => gradeRecipients(tx, tenant.students[0]!.id),
    );
    expect(recipients.sort()).toEqual(
      [tenant.students[0]!.userId, tenant.users[ROLES.PARENT]!.id].sort(),
    );
    const other = await withTenantTx(
      appDatabaseFor(database!.sql),
      { schoolId: tenant.schoolId, userId: tenant.users[ROLES.ORG_ADMIN]!.id },
      (tx) => gradeRecipients(tx, otherStudentId),
    );
    expect(other).not.toContain(tenant.users[ROLES.PARENT]!.id);
  });
});
