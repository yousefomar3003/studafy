/**
 * QA-12 / F-03: the tenant provisioning routes cannot be used for self-promotion.
 *
 * `POST /api/schools/{schoolId}/provision` grants the caller ORG_ADMIN in the target school (it
 * passes `auth.userId` as the provisioned admin). It used to be exempt from the permission guard and
 * took the school from the path without comparing it to the caller's, so any signed-in user -- a
 * student included -- could make themselves an admin of their own school or of any other.
 *
 * Each refusal is checked for its side effects as well as its status: no `app.user_roles` row is
 * written and the target's `provisioning_status` does not move. A status-only test would pass if the
 * handler refused *after* doing the work.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestApp,
  type TestDatabase,
} from "../harness";

import type { Role } from "@studafy/constants";

const integrationTest = test.skipIf(!integrationEnabled);

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
}

let db: TestDatabase;
let testApp: TestApp & { ready: Promise<void> };

let schoolA: string;
let schoolB: string;
let studentA: Actor;
let instructorA: Actor;
let orgAdminA: Actor;
let orgAdminB: Actor;

/** Every role row, in every school, held by `userId`. */
function rolesOf(userId: string): Promise<{ school_id: string; role: string }[]> {
  // The harness connection owns the database, so these reads see every school's rows past RLS.
  return db.sql<{ school_id: string; role: string }[]>`
    SELECT school_id::text, role::text FROM app.user_roles
    WHERE user_id = ${userId}::uuid ORDER BY school_id, role
  `;
}

/** The school's provisioning status, or null when it has never been provisioned. */
async function provisioningStatusOf(schoolId: string): Promise<string | null> {
  const rows = await db.sql<{ provisioning_status: string }[]>`
    SELECT provisioning_status::text FROM app.subscriptions WHERE school_id = ${schoolId}::uuid
  `;
  return rows[0]?.provisioning_status ?? null;
}

async function newActor(schoolId: string, role: Role): Promise<Actor> {
  const user = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, user.id, role);
  return { schoolId, userId: user.id, roles: [role] };
}

function provision(actor: Actor, schoolId: string): Promise<Response> {
  return authenticatedRequest(testApp, "POST", `/api/schools/${schoolId}/provision`, actor);
}

function readStatus(actor: Actor, schoolId: string): Promise<Response> {
  return authenticatedRequest(
    testApp,
    "GET",
    `/api/schools/${schoolId}/provisioning-status`,
    actor,
  );
}

/**
 * Assert a refused provision left no trace: the caller's role rows are exactly what they were, and
 * the target school's provisioning status has not moved.
 */
async function expectNoSideEffects(
  actor: Actor,
  targetSchoolId: string,
  before: { roles: { school_id: string; role: string }[]; status: string | null },
): Promise<void> {
  expect(await rolesOf(actor.userId)).toEqual(before.roles);
  expect(await provisioningStatusOf(targetSchoolId)).toBe(before.status);
}

async function snapshot(actor: Actor, targetSchoolId: string) {
  return {
    roles: await rolesOf(actor.userId),
    status: await provisioningStatusOf(targetSchoolId),
  };
}

describe("QA-12: provisioning routes are admin-only and own-school-only", () => {
  beforeAll(async () => {
    if (!integrationEnabled) return;

    db = await createTestDatabase();
    await migrateDatabase(db.url);
    testApp = createTestApp({ database: db.sql });
    await testApp.ready;

    schoolA = (await createSchool(db.sql)).id;
    schoolB = (await createSchool(db.sql)).id;
    studentA = await newActor(schoolA, "STUDENT");
    instructorA = await newActor(schoolA, "INSTRUCTOR");
    orgAdminA = await newActor(schoolA, "ORG_ADMIN");
    orgAdminB = await newActor(schoolB, "ORG_ADMIN");

    // School B: provisioned by its own admin, then left retryable ('failed'), so a request that got
    // past the guards would re-run provisioning and move the status -- the refusal is observable.
    const res = await provision(orgAdminB, schoolB);
    expect(res.status).toBe(200);
    await db.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      // The subscriptions audit trigger stamps the row with the tenant it was changed under.
      await tx`SELECT set_config('app.school_id', ${schoolB}, true)`;
      await tx`
        UPDATE app.subscriptions SET provisioning_status = 'failed'::app.provisioning_status
        WHERE school_id = ${schoolB}::uuid
      `;
    });
  }, 120_000);

  afterAll(async () => {
    if (!integrationEnabled) return;
    testApp?.keyStore.destroy();
    await db?.cleanup();
  });

  integrationTest(
    "a STUDENT provisioning their own school gets 403 and no ORG_ADMIN row",
    async () => {
      const before = await snapshot(studentA, schoolA);
      expect(before.status).toBeNull();

      const res = await provision(studentA, schoolA);

      expect(res.status).toBe(403);
      await expectNoSideEffects(studentA, schoolA, before);
    },
  );

  integrationTest(
    "an INSTRUCTOR provisioning their own school gets 403 and no ORG_ADMIN row",
    async () => {
      const before = await snapshot(instructorA, schoolA);

      const res = await provision(instructorA, schoolA);

      expect(res.status).toBe(403);
      await expectNoSideEffects(instructorA, schoolA, before);
    },
  );

  integrationTest("a STUDENT provisioning another school gets 403 and no row there", async () => {
    const before = await snapshot(studentA, schoolB);
    expect(before.status).toBe("failed");

    const res = await provision(studentA, schoolB);

    expect(res.status).toBe(403);
    await expectNoSideEffects(studentA, schoolB, before);
  });

  integrationTest(
    "an ORG_ADMIN of school A provisioning school B gets 404 and no row there",
    async () => {
      const before = await snapshot(orgAdminA, schoolB);

      const res = await provision(orgAdminA, schoolB);

      expect(res.status).toBe(404);
      await expectNoSideEffects(orgAdminA, schoolB, before);
      expect((await rolesOf(orgAdminA.userId)).some((r) => r.school_id === schoolB)).toBe(false);
    },
  );

  integrationTest(
    "an ORG_ADMIN of school A provisioning a school that does not exist gets 404",
    async () => {
      const res = await provision(orgAdminA, crypto.randomUUID());
      expect(res.status).toBe(404);
    },
  );

  integrationTest("provisioning status is admin-only and own-school-only too", async () => {
    expect((await readStatus(studentA, schoolA)).status).toBe(403);
    expect((await readStatus(orgAdminA, schoolB)).status).toBe(404);
    expect((await readStatus(orgAdminB, schoolB)).status).toBe(200);
  });

  // Last: it provisions school A, which the earlier cases rely on being unprovisioned.
  integrationTest("an ORG_ADMIN provisioning their own school still succeeds", async () => {
    const res = await provision(orgAdminA, schoolA);

    expect(res.status).toBe(200);
    expect(await provisioningStatusOf(schoolA)).toBe("completed");
  });
});
