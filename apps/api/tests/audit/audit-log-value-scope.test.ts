/**
 * QA-040: the audit log does not hand out the data it records to roles that may not read it.
 *
 * FINANCE (and SUPPORT_AGENT) hold AUDIT_LOG_READ, and the explorer returned `old_values` and
 * `new_values` for every table. Grade writes audit the scores themselves, so FINANCE could read
 * every mark it has no GRADE_READ for; the same held for discipline and records. Values are now
 * shown in full to school administrators, to FINANCE for finance tables only, and to no one else;
 * the rows themselves (who did what, when, to which record) stay visible.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/audit/audit-log-value-scope.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createUser,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase, TenantFixture } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
let financeUserId: string;
const gradeRowTarget = crypto.randomUUID();
const paymentRowTarget = crypto.randomUUID();

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
  financeUserId = (await createUser(database.sql, tenant.schoolId)).id;
  await assignRole(database.sql, tenant.schoolId, financeUserId, ROLES.FINANCE);
  await database.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    await tx`
      INSERT INTO app.audit_logs (school_id, action, target_table, target_id, old_values, new_values)
      VALUES
        (${tenant.schoolId}::uuid, 'update', 'grades', ${gradeRowTarget}::uuid,
         ${tx.json({ score: 41 })}, ${tx.json({ score: 93 })}),
        (${tenant.schoolId}::uuid, 'insert', 'payment_cache', ${paymentRowTarget}::uuid,
         NULL, ${tx.json({ amount_minor: 125000 })})
    `;
  });
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

interface Entry {
  target_id: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

async function entriesAs(role: Role): Promise<Map<string, Entry>> {
  const response = await authenticatedRequest(harness!, "GET", "/api/audit/logs?limit=100", {
    schoolId: tenant.schoolId,
    userId: role === ROLES.FINANCE ? financeUserId : tenant.users[role]!.id,
    roles: [role],
    channel: "web",
  });
  expect(response.status).toBe(200);
  const { items } = (await response.json()) as { items: Entry[] };
  return new Map(items.map((item) => [item.target_id, item]));
}

describeDb("audit log value scope (QA-040)", () => {
  test("FINANCE sees that a grade changed, but not the scores", async () => {
    const grade = (await entriesAs(ROLES.FINANCE)).get(gradeRowTarget);
    expect(grade).toBeDefined();
    expect(grade!.old_values).toBeNull();
    expect(grade!.new_values).toBeNull();
  });

  test("FINANCE still sees finance values in full", async () => {
    const payment = (await entriesAs(ROLES.FINANCE)).get(paymentRowTarget);
    expect(payment!.new_values).toEqual({ amount_minor: 125000 });
  });

  test("ORG_ADMIN sees every value", async () => {
    const grade = (await entriesAs(ROLES.ORG_ADMIN)).get(gradeRowTarget);
    expect(grade!.new_values).toEqual({ score: 93 });
  });
});
