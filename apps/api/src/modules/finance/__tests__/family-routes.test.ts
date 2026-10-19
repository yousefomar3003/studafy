/**
 * Family financial view over HTTP, with the ERPNext integration switched off.
 *
 * GET /api/finance/families/{familyId} reads only the local finance read models, so it must be
 * mounted (and answer) on a deployment — or a dev machine — with no ERPNEXT_* configuration. The
 * ERPNext-backed finance routes stay mounted too and answer 503 ERPNEXT_NOT_CONFIGURED; that is
 * their contract and is covered elsewhere. Also proves a parent can discover their own family id
 * through GET /api/families, which is how the parent app finds the id to ask for.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
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
} from "../../../../tests/harness";

import type { TenantFixture, TestApp, TestDatabase } from "../../../../tests/harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let fixture: TenantFixture | undefined;
let familyId: string | undefined;
const savedErpNextEnv = {
  url: process.env.ERPNEXT_API_URL,
  key: process.env.ERPNEXT_API_KEY,
};

beforeAll(async () => {
  if (!integrationEnabled) return;
  delete process.env.ERPNEXT_API_URL;
  delete process.env.ERPNEXT_API_KEY;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  fixture = await createFullTenant(database.sql);

  await database.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture!.schoolId}, true)`;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${fixture!.schoolId}::uuid, 'No-ERPNext family', ${fixture!.users.PARENT.id}::uuid)
      RETURNING id
    `;
    familyId = family!.id;
    await tx`
      INSERT INTO app.parent_child_links
        (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (
        ${fixture!.schoolId}::uuid, ${familyId}::uuid, ${fixture!.users.PARENT.id}::uuid,
        ${fixture!.students[0]!.id}::uuid, 'father'
      )
    `;
  });

  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
  if (savedErpNextEnv.url !== undefined) process.env.ERPNEXT_API_URL = savedErpNextEnv.url;
  if (savedErpNextEnv.key !== undefined) process.env.ERPNEXT_API_KEY = savedErpNextEnv.key;
});

function asParent() {
  return {
    schoolId: fixture!.schoolId,
    userId: fixture!.users.PARENT.id,
    roles: [ROLES.PARENT],
  };
}

describeDb("family financial view without ERPNext", () => {
  test("a parent finds their family id through GET /api/families", async () => {
    const response = await authenticatedRequest(harness!, "GET", "/api/families", asParent());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { families: { id: string }[]; total: number };
    expect(body.families.map((family) => family.id)).toEqual([familyId!]);
    expect(body.total).toBe(1);
  });

  test("serves the household view from the local read models", async () => {
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/finance/families/${familyId}`,
      asParent(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      family_id: string;
      students: { student_id: string; invoices: unknown[]; payments: unknown[] }[];
    };
    expect(body.family_id).toBe(familyId!);
    expect(body.students.map((student) => student.student_id)).toEqual([fixture!.students[0]!.id]);
    expect(body.students[0]!.invoices).toEqual([]);
    expect(body.students[0]!.payments).toEqual([]);
  });

  test("still hides a family from a parent who is not in it", async () => {
    const stranger = await createUser(database!.sql, fixture!.schoolId, {
      displayName: "Stranger Parent",
    });
    await assignRole(database!.sql, fixture!.schoolId, stranger.id, ROLES.PARENT);

    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/finance/families/${familyId}`,
      { schoolId: fixture!.schoolId, userId: stranger.id, roles: [ROLES.PARENT] },
    );

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });
});
