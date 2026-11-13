/**
 * QA-10 / F-01: no school-side caller can hand out a platform role.
 *
 * Before the fix an ORG_ADMIN could `PATCH /api/users/{id}/role {"role":"SUPER_ADMIN"}` (or create a
 * user with it) on anyone in their school, themselves included; the next refresh minted a
 * SUPER_ADMIN token and `/api/platform/*` ran across every school. Two layers now stop that:
 *
 * - API: the school user endpoints accept only school roles (`ASSIGNABLE_ROLES`), and a platform
 *   role's holder can only be re-roled by a SUPER_ADMIN (`canChangeRoleOf`).
 * - Database (000185): a platform role can only be held in a school flagged `is_platform_tenant`, a
 *   flag only studafy_admin can set. So even a raw `studafy_app` write cannot escalate.
 *
 * Granting ORG_ADMIN stays allowed: a school may have several admins, and invitations have always
 * offered it (permission-matrix.md "Role grants").
 */

// Imported before src/middleware — see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
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
  registerPlatformSchool,
} from "../harness";

import type { TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

const PLATFORM_ROLES: Role[] = [ROLES.SUPER_ADMIN, ROLES.SUPPORT_AGENT];

let database: TestDatabase | undefined;
let sql: Sql;
let testApp: TestApp;
let schoolId: string;
let orgAdminId: string;
let instructorId: string;
let platformSchoolId: string;
let platformOrgAdminId: string;
let platformSuperAdminId: string;

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;

  const school = await createSchool(sql);
  schoolId = school.id;
  const orgAdmin = await createUser(sql, schoolId);
  await assignRole(sql, schoolId, orgAdmin.id, ROLES.ORG_ADMIN);
  orgAdminId = orgAdmin.id;
  const instructor = await createUser(sql, schoolId);
  await assignRole(sql, schoolId, instructor.id, ROLES.INSTRUCTOR);
  instructorId = instructor.id;

  const platformSchool = await createSchool(sql);
  platformSchoolId = platformSchool.id;
  await registerPlatformSchool(sql, platformSchoolId);
  const platformOrgAdmin = await createUser(sql, platformSchoolId);
  await assignRole(sql, platformSchoolId, platformOrgAdmin.id, ROLES.ORG_ADMIN);
  platformOrgAdminId = platformOrgAdmin.id;
  const platformSuperAdmin = await createUser(sql, platformSchoolId);
  await assignRole(sql, platformSchoolId, platformSuperAdmin.id, ROLES.SUPER_ADMIN);
  platformSuperAdminId = platformSuperAdmin.id;

  const created = createTestApp({ database: sql });
  await created.ready;
  testApp = created;
}, 60_000);

afterAll(async () => {
  testApp?.keyStore.destroy();
  await database?.cleanup();
});

async function rolesOf(userId: string): Promise<string[]> {
  const rows = await sql<{ role: string }[]>`
    SELECT role::text AS role FROM app.user_roles WHERE user_id = ${userId}::uuid ORDER BY role
  `;
  return rows.map((row) => row.role);
}

async function isPlatformTenant(school: string): Promise<boolean> {
  const [row] = await sql<{ is_platform_tenant: boolean }[]>`
    SELECT is_platform_tenant FROM app.schools WHERE id = ${school}::uuid
  `;
  return row!.is_platform_tenant;
}

function asOrgAdmin(
  method: string,
  path: string,
  body: unknown,
  school = schoolId,
  user = orgAdminId,
) {
  return authenticatedRequest(
    testApp,
    method,
    path,
    { schoolId: school, userId: user, roles: [ROLES.ORG_ADMIN], channel: "web" },
    { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  );
}

/** Runs `fn` exactly as the API's tenant transactions do: studafy_app with the school armed. */
async function asApp<T>(school: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    result = await fn(tx as unknown as Sql);
  });
  return result as T;
}

/**
 * The message `attempt` failed with, or "" if it succeeded. Not `expect(attempt).rejects`: under
 * Bun that stalls a postgres.js transaction before its first query until the test times out.
 */
async function failureOf(attempt: Promise<unknown>): Promise<string> {
  return attempt.then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("F-01 API: an ORG_ADMIN cannot grant a platform role", () => {
  for (const role of PLATFORM_ROLES) {
    integrationTest(`PATCH /api/users/{id}/role ${role} on another user is refused`, async () => {
      const res = await asOrgAdmin("PATCH", `/api/users/${instructorId}/role`, { role });
      expect([400, 403]).toContain(res.status);
      expect(await rolesOf(instructorId)).toEqual([ROLES.INSTRUCTOR]);
    });

    integrationTest(`PATCH /api/users/{id}/role ${role} on themselves is refused`, async () => {
      const res = await asOrgAdmin("PATCH", `/api/users/${orgAdminId}/role`, { role });
      expect([400, 403]).toContain(res.status);
      expect(await rolesOf(orgAdminId)).toEqual([ROLES.ORG_ADMIN]);
    });

    integrationTest(`POST /api/users with role ${role} is refused`, async () => {
      const email = `escalate-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@test.local`;
      const res = await asOrgAdmin("POST", "/api/users", {
        email,
        display_name: "Escalation probe",
        role,
      });
      expect([400, 403]).toContain(res.status);
      const [{ count }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.users WHERE normalized_email = ${email}
      `;
      expect(count).toBe(0);
    });

    integrationTest(`${role} is refused even in a platform school`, async () => {
      const res = await asOrgAdmin(
        "PATCH",
        `/api/users/${platformOrgAdminId}/role`,
        { role },
        platformSchoolId,
        platformOrgAdminId,
      );
      expect([400, 403]).toContain(res.status);
      expect(await rolesOf(platformOrgAdminId)).toEqual([ROLES.ORG_ADMIN]);
    });
  }

  integrationTest("an ORG_ADMIN cannot re-role a SUPER_ADMIN", async () => {
    const res = await asOrgAdmin(
      "PATCH",
      `/api/users/${platformSuperAdminId}/role`,
      { role: ROLES.GUEST },
      platformSchoolId,
      platformOrgAdminId,
    );
    expect(res.status).toBe(403);
    expect(await rolesOf(platformSuperAdminId)).toEqual([ROLES.SUPER_ADMIN]);
  });

  // The documented product rule: a school may have more than one admin.
  integrationTest("an ORG_ADMIN may make another user ORG_ADMIN", async () => {
    const colleague = await createUser(sql, schoolId);
    await assignRole(sql, schoolId, colleague.id, ROLES.PRINCIPAL);
    const res = await asOrgAdmin("PATCH", `/api/users/${colleague.id}/role`, {
      role: ROLES.ORG_ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await rolesOf(colleague.id)).toEqual([ROLES.ORG_ADMIN]);
  });
});

describe("F-01 database: a platform role lives only in a platform school", () => {
  for (const role of PLATFORM_ROLES) {
    integrationTest(`studafy_app cannot INSERT ${role} in an ordinary school`, async () => {
      const user = await createUser(sql, schoolId);
      const attempt = asApp(
        schoolId,
        (tx) => tx`
        INSERT INTO app.user_roles (school_id, user_id, role)
        VALUES (${schoolId}::uuid, ${user.id}::uuid, ${role}::app.user_role)
      `,
      );
      expect(await failureOf(attempt)).toMatch(/platform role/);
      expect(await rolesOf(user.id)).toEqual([]);
    });

    integrationTest(
      `studafy_app cannot UPDATE a role to ${role} in an ordinary school`,
      async () => {
        const attempt = asApp(
          schoolId,
          (tx) => tx`
        UPDATE app.user_roles SET role = ${role}::app.user_role
        WHERE user_id = ${instructorId}::uuid
      `,
        );
        expect(await failureOf(attempt)).toMatch(/platform role/);
        expect(await rolesOf(instructorId)).toEqual([ROLES.INSTRUCTOR]);
      },
    );
  }

  integrationTest("studafy_app cannot flag its own school as a platform school", async () => {
    const attempt = asApp(
      schoolId,
      (tx) => tx`
      UPDATE app.schools SET is_platform_tenant = true WHERE id = ${schoolId}::uuid
    `,
    );
    expect(await failureOf(attempt)).toMatch(/only studafy_admin/);
    expect(await isPlatformTenant(schoolId)).toBe(false);
  });

  integrationTest("studafy_app cannot register a new school as a platform school", async () => {
    const slug = `escalate-${crypto.randomUUID().slice(0, 8)}`;
    const attempt = asApp(
      schoolId,
      (tx) => tx`
      INSERT INTO app.schools
        (slug, name, email, normalized_email, country_id, default_currency_id, is_platform_tenant)
      SELECT ${slug}, ${slug}, ${`${slug}@test.local`}, ${`${slug}@test.local`},
             country_id, default_currency_id, true
      FROM app.schools WHERE id = ${schoolId}::uuid
    `,
    );
    expect(await failureOf(attempt)).toMatch(/only studafy_admin/);
  });

  integrationTest("studafy_app cannot unflag a platform school", async () => {
    const attempt = asApp(
      platformSchoolId,
      (tx) => tx`
      UPDATE app.schools SET is_platform_tenant = false WHERE id = ${platformSchoolId}::uuid
    `,
    );
    expect(await failureOf(attempt)).toMatch(/only studafy_admin/);
    expect(await isPlatformTenant(platformSchoolId)).toBe(true);
  });

  integrationTest("a platform school may hold SUPPORT_AGENT", async () => {
    const user = await createUser(sql, platformSchoolId);
    await asApp(
      platformSchoolId,
      (tx) => tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (${platformSchoolId}::uuid, ${user.id}::uuid, 'SUPPORT_AGENT'::app.user_role)
    `,
    );
    expect(await rolesOf(user.id)).toEqual([ROLES.SUPPORT_AGENT]);
  });
});
