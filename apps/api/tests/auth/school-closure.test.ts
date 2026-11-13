/**
 * School closure by its own administrator (POST /api/schools/current/closure) and the school read
 * the mobile confirmation screen needs (GET /api/schools/current).
 *
 * Closing archives the school, keeps every row it owns, and locks every member out at once: the
 * access tokens already in their hands are answered SCHOOL_SUSPENDED on the next request (the
 * school's entitlement version was bumped), their refresh tokens are revoked and refused with the
 * same code, and sign-in refuses the school for every role — ORG_ADMIN included, unlike a mere
 * suspension. Nothing in another school is touched.
 */

// Imported before src/middleware — see the note at the top of ./support.ts.
import "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { withTenantTx } from "../../src/db/tenant-tx";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS, issueTokenPair, KeyStore } from "../../src/modules/auth";
import {
  assignRole,
  createFullTenant,
  createRefreshSession,
  createSchool,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";

import type { AppEnv } from "../../src/middleware";
import type { AuthChannel } from "../../src/modules/auth";
import type { TenantFixture, TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Role } from "@studafy/constants";
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

const CLOSED_NAME = "Closure Test Academy";
const OTHER_NAME = "Neighbour Test Academy";

let database: TestDatabase | undefined;
let sql: Sql;
let app: OpenAPIHono<AppEnv>;
let keyStore: KeyStore;
/** The school that gets closed. */
let tenant: TenantFixture;
/** A second, untouched school: the isolation control. */
let other: { schoolId: string; adminId: string };
let principalId: string;
let financeId: string;
/** What the injected Microsoft verifier answers with; set per login. */
let loginSubject = "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function asAdmin<T>(schoolId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

async function activate(schoolId: string, name: string): Promise<void> {
  await asAdmin(schoolId, async (tx) => {
    await tx`
      UPDATE app.schools SET status = 'active'::app.school_status, name = ${name}
       WHERE id = ${schoolId}
    `;
  });
}

async function seedOAuthIdentity(schoolId: string, userId: string, subject: string): Promise<void> {
  await asAdmin(schoolId, async (tx) => {
    await tx`
      INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
      VALUES (${schoolId}, ${userId}, 'microsoft', ${subject})
    `;
  });
}

function tokenFor(
  schoolId: string,
  userId: string,
  roles: Role[],
  channel: AuthChannel = AUTH_CHANNELS.MOBILE,
): Promise<string> {
  return mintTestToken(keyStore, { schoolId, userId, roles, channel });
}

function getSchool(token: string): Promise<Response> {
  return Promise.resolve(
    app.request("/api/schools/current", { headers: { Authorization: `Bearer ${token}` } }),
  );
}

function closeSchool(token: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request("/api/schools/current/closure", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function refresh(refreshToken: string): Promise<Response> {
  return Promise.resolve(
    app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }),
  );
}

function login(subject: string): Promise<Response> {
  loginSubject = subject;
  return Promise.resolve(
    app.request("/api/auth/login/oauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: "stub-id-token", nonce: "stub-nonce", channel: "mobile" }),
    }),
  );
}

async function problemCode(response: Response): Promise<unknown> {
  return ((await response.json()) as Record<string, unknown>).code;
}

async function schoolRow(
  schoolId: string,
): Promise<{ status: string; closed_at: Date | null; closed_by: string | null }> {
  return asAdmin(schoolId, async (tx) => {
    const [row] = await tx<{ status: string; closed_at: Date | null; closed_by: string | null }[]>`
      SELECT status::text AS status, closed_at, closed_by::text AS closed_by
        FROM app.schools WHERE id = ${schoolId}
    `;
    return row!;
  });
}

async function liveSessions(schoolId: string): Promise<number> {
  return asAdmin(schoolId, async (tx) => {
    const [row] = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM app.refresh_tokens
       WHERE school_id = ${schoolId} AND revoked_at IS NULL
    `;
    return Number(row!.count);
  });
}

async function dataFootprint(schoolId: string): Promise<Record<string, number>> {
  return asAdmin(schoolId, async (tx) => {
    const [row] = await tx<Record<string, string>[]>`
      SELECT
        (SELECT count(*) FROM app.users WHERE school_id = ${schoolId})::text AS users,
        (SELECT count(*) FROM app.user_roles WHERE school_id = ${schoolId})::text AS roles,
        (SELECT count(*) FROM app.students WHERE school_id = ${schoolId})::text AS students,
        (SELECT count(*) FROM app.classes WHERE school_id = ${schoolId})::text AS classes,
        (SELECT count(*) FROM app.enrollments WHERE school_id = ${schoolId})::text AS enrollments
    `;
    return Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)]));
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;

  tenant = await createFullTenant(sql);
  await activate(tenant.schoolId, CLOSED_NAME);

  const principal = await createUser(sql, tenant.schoolId);
  await assignRole(sql, tenant.schoolId, principal.id, ROLES.PRINCIPAL);
  principalId = principal.id;
  const finance = await createUser(sql, tenant.schoolId);
  await assignRole(sql, tenant.schoolId, finance.id, ROLES.FINANCE);
  financeId = finance.id;

  const otherSchool = await createSchool(sql);
  await activate(otherSchool.id, OTHER_NAME);
  const otherAdmin = await createUser(sql, otherSchool.id);
  await assignRole(sql, otherSchool.id, otherAdmin.id, ROLES.ORG_ADMIN);
  other = { schoolId: otherSchool.id, adminId: otherAdmin.id };

  keyStore = new KeyStore(60_000);
  await keyStore.init();
  resetSecurityConfig();

  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    database: sql,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
    microsoftIdentityVerifier: () =>
      Promise.resolve({ subject: loginSubject, email: "closure@example.test" }),
  });
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

// ---------------------------------------------------------------------------
// GET /api/schools/current
// ---------------------------------------------------------------------------

describe("GET /api/schools/current", () => {
  integrationTest("returns the caller's own school to any role, on mobile", async () => {
    const token = await tokenFor(tenant.schoolId, tenant.users.STUDENT.id, [ROLES.STUDENT]);
    const response = await getSchool(token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: tenant.schoolId,
      name: CLOSED_NAME,
      status: "active",
    });
  });
});

// ---------------------------------------------------------------------------
// Refusals — none of these may close anything
// ---------------------------------------------------------------------------

describe("POST /api/schools/current/closure refusals", () => {
  const nonAdmins: [Role, () => string][] = [
    [ROLES.PRINCIPAL, () => principalId],
    [ROLES.FINANCE, () => financeId],
    [ROLES.INSTRUCTOR, () => tenant.users.INSTRUCTOR.id],
    [ROLES.STUDENT, () => tenant.users.STUDENT.id],
    [ROLES.PARENT, () => tenant.users.PARENT.id],
    [ROLES.GUEST, () => tenant.users.GUEST.id],
    [ROLES.SUPPORT_AGENT, () => tenant.users.SUPPORT_AGENT.id],
  ];

  for (const [role, userId] of nonAdmins) {
    integrationTest(`${role} is forbidden`, async () => {
      const token = await tokenFor(tenant.schoolId, userId(), [role]);
      const response = await closeSchool(token, { confirm_school_name: CLOSED_NAME });

      expect(response.status).toBe(403);
      expect((await schoolRow(tenant.schoolId)).status).toBe("active");
    });
  }

  integrationTest("SUPER_ADMIN without ORG_ADMIN is forbidden by the role check", async () => {
    const token = await tokenFor(tenant.schoolId, tenant.users.SUPER_ADMIN.id, [ROLES.SUPER_ADMIN]);
    const response = await closeSchool(token, { confirm_school_name: CLOSED_NAME });

    expect(response.status).toBe(403);
    expect(await problemCode(response)).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
    expect((await schoolRow(tenant.schoolId)).status).toBe("active");
  });

  integrationTest("an API-channel token is refused by the channel guard", async () => {
    const token = await tokenFor(
      tenant.schoolId,
      tenant.users.ORG_ADMIN.id,
      [ROLES.ORG_ADMIN],
      AUTH_CHANNELS.API,
    );
    const response = await closeSchool(token, { confirm_school_name: CLOSED_NAME });

    expect(response.status).toBe(403);
    expect(await problemCode(response)).toBe(ERROR_CODES.CHANNEL_NOT_AUTHORIZED);
  });

  integrationTest("a wrong school name is rejected with SCHOOL_CLOSURE_NAME_MISMATCH", async () => {
    const token = await tokenFor(tenant.schoolId, tenant.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN]);
    const response = await closeSchool(token, { confirm_school_name: `${CLOSED_NAME} X` });

    expect(response.status).toBe(422);
    expect(await problemCode(response)).toBe(ERROR_CODES.SCHOOL_CLOSURE_NAME_MISMATCH);
    expect((await schoolRow(tenant.schoolId)).status).toBe("active");
  });

  integrationTest("a missing confirmation is a validation failure", async () => {
    const token = await tokenFor(tenant.schoolId, tenant.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN]);
    const response = await closeSchool(token, {});

    expect(response.status).toBe(400);
    expect((await schoolRow(tenant.schoolId)).status).toBe("active");
  });

  // There is no school parameter to point at another tenant: the target is always the caller's own
  // school, so typing a neighbour's name is just a mismatch against one's own.
  integrationTest("another school's admin cannot close this school", async () => {
    const token = await tokenFor(other.schoolId, other.adminId, [ROLES.ORG_ADMIN]);
    const response = await closeSchool(token, { confirm_school_name: CLOSED_NAME });

    expect(response.status).toBe(422);
    expect((await schoolRow(tenant.schoolId)).status).toBe("active");
    expect((await schoolRow(other.schoolId)).status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Closure
// ---------------------------------------------------------------------------

describe("closing the school", () => {
  integrationTest(
    "archives the school, signs everyone out, refuses sign-in and keeps the data",
    async () => {
      // Live sessions in both schools, and access tokens already in members' hands.
      const teacherSession = await createRefreshSession(
        sql,
        tenant.schoolId,
        tenant.users.INSTRUCTOR.id,
        { channel: "mobile" },
      );
      await createRefreshSession(sql, tenant.schoolId, tenant.users.ORG_ADMIN.id, {
        channel: "mobile",
      });
      await createRefreshSession(sql, tenant.schoolId, tenant.users.PARENT.id, { channel: "web" });
      const otherSession = await createRefreshSession(sql, other.schoolId, other.adminId, {
        channel: "mobile",
      });

      const teacherToken = await tokenFor(tenant.schoolId, tenant.users.INSTRUCTOR.id, [
        ROLES.INSTRUCTOR,
      ]);
      const otherAdminToken = await tokenFor(other.schoolId, other.adminId, [ROLES.ORG_ADMIN]);
      expect((await getSchool(teacherToken)).status).toBe(200);

      const adminSubject = `sub-${crypto.randomUUID()}`;
      await seedOAuthIdentity(tenant.schoolId, tenant.users.ORG_ADMIN.id, adminSubject);
      const teacherSubject = `sub-${crypto.randomUUID()}`;
      await seedOAuthIdentity(tenant.schoolId, tenant.users.INSTRUCTOR.id, teacherSubject);

      const before = await dataFootprint(tenant.schoolId);
      expect(await liveSessions(tenant.schoolId)).toBe(3);

      // --- Close: trimmed and case-insensitive confirmation, from the mobile app.
      const adminToken = await tokenFor(tenant.schoolId, tenant.users.ORG_ADMIN.id, [
        ROLES.ORG_ADMIN,
      ]);
      const response = await closeSchool(adminToken, {
        confirm_school_name: `  ${CLOSED_NAME.toUpperCase()} `,
        reason: "Moving to another provider",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, string>;
      expect(body.school_id).toBe(tenant.schoolId);
      expect(body.status).toBe("archived");
      expect(Number.isNaN(Date.parse(body.closed_at!))).toBe(false);

      const row = await schoolRow(tenant.schoolId);
      expect(row.status).toBe("archived");
      expect(row.closed_at).not.toBeNull();
      expect(row.closed_by).toBe(tenant.users.ORG_ADMIN.id);

      // --- Every session in the school is revoked; none elsewhere.
      expect(await liveSessions(tenant.schoolId)).toBe(0);
      expect(await liveSessions(other.schoolId)).toBe(1);

      // --- The closure is audited, with the actor and the reason.
      const audit = await asAdmin(tenant.schoolId, async (tx) => {
        return tx<{ actor_id: string; new_values: Record<string, unknown> }[]>`
          SELECT actor_id::text AS actor_id, new_values FROM app.audit_logs
           WHERE target_table = 'schools' AND new_values->>'source' = 'school_admin_closure'
        `;
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor_id).toBe(tenant.users.ORG_ADMIN.id);
      expect(audit[0]!.new_values.reason).toBe("Moving to another provider");
      expect(audit[0]!.new_values.sessions_revoked).toBe(3);

      // --- An access token minted before the closure is dead on its next request.
      const stale = await getSchool(teacherToken);
      expect(stale.status).toBe(403);
      expect(await problemCode(stale)).toBe(ERROR_CODES.SCHOOL_SUSPENDED);

      // --- Its refresh token cannot bring it back, and is not mistaken for token theft.
      const refreshed = await refresh(teacherSession.token);
      expect(refreshed.status).toBe(403);
      expect(await problemCode(refreshed)).toBe(ERROR_CODES.SCHOOL_SUSPENDED);

      // --- Nobody can sign in again: not a teacher, and not the admin (whom a mere suspension admits).
      for (const subject of [teacherSubject, adminSubject]) {
        const denied = await login(subject);
        expect(denied.status).toBe(403);
        expect(await problemCode(denied)).toBe(ERROR_CODES.SCHOOL_SUSPENDED);
      }

      // --- No token issuance path can mint for the school (the web OAuth callbacks rely on this).
      const issued = withTenantTx(
        sql,
        { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id },
        (tx) =>
          issueTokenPair(
            tx,
            {
              keyStore,
              issuer: TEST_JWT_ISSUER,
              audience: TEST_JWT_AUDIENCE,
              accessTtlSeconds: 900,
              refreshTtlSeconds: 3600,
            },
            { userId: tenant.users.ORG_ADMIN.id, schoolId: tenant.schoolId, channel: "mobile" },
          ),
      );
      await expect(issued).rejects.toMatchObject({
        status: 403,
        code: ERROR_CODES.SCHOOL_SUSPENDED,
      });

      // --- All of the school's data is still there.
      expect(await dataFootprint(tenant.schoolId)).toEqual(before);

      // --- The neighbouring school is untouched.
      expect((await schoolRow(other.schoolId)).status).toBe("active");
      expect((await getSchool(otherAdminToken)).status).toBe(200);
      expect((await refresh(otherSession.token)).status).toBe(200);
    },
  );
});
