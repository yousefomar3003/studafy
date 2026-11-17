/**
 * QA-011: attaching a receipt to an expense requires billing:update, like every other expense write.
 *
 * The expense guards were mounted on `/api/finance/expenses` and `/api/finance/expenses/:expenseId`.
 * Hono's `:expenseId` matches exactly one path segment, so neither ran for
 * `POST /api/finance/expenses/{id}/attachments`: any signed-in member of the school -- a student
 * included -- could replace a finance receipt and read the expense back.
 *
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL:
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/finance/expense-attachment-authz.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
} from "../harness";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
let financeUserId: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
  const finance = await createUser(database.sql, tenant.schoolId, { displayName: "Finance" });
  await assignRole(database.sql, tenant.schoolId, finance.id, ROLES.FINANCE);
  financeUserId = finance.id;
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

async function attach(role: Role): Promise<number> {
  const token = await mintTestToken(harness!.keyStore, {
    schoolId: tenant.schoolId,
    userId: role === ROLES.FINANCE ? financeUserId : tenant.users[role].id,
    roles: [role],
    channel: "web",
  });
  const response = await harness!.app.request(
    "/api/finance/expenses/HR-EXP-2026-00001/attachments",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ storage_key: `temp/${tenant.schoolId}/${crypto.randomUUID()}/x.pdf` }),
    },
  );
  return response.status;
}

describeDb("POST /api/finance/expenses/{expenseId}/attachments (QA-011)", () => {
  for (const role of [ROLES.STUDENT, ROLES.PARENT, ROLES.INSTRUCTOR, ROLES.GUEST]) {
    test(`${role} is refused before the handler runs`, async () => {
      expect(await attach(role)).toBe(403);
    });
  }

  for (const role of [ROLES.FINANCE, ROLES.ORG_ADMIN]) {
    test(`${role} passes the permission gate`, async () => {
      // No storage is configured in this harness, so the handler answers after the gate (503);
      // the point is only that the permission gate does not refuse a billing:update holder.
      expect(await attach(role)).not.toBe(403);
    });
  }
});
