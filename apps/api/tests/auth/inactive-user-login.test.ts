/**
 * QA-010: a suspended or archived user gets no new session, by any path.
 *
 * Deactivating a user revoked their sessions, but nothing on the OAuth path read `app.users.status`
 * -- not the identity resolver (000034), not loginReturningUser, not issueTokenPair -- so the user
 * signed straight back in with Google/Microsoft and got their old roles. Refresh rotation never
 * checked status either, and `PATCH /api/users/{id} {"status":"suspended"}` changed the status
 * without revoking anything. Member-password login already refused inactive accounts; every other
 * path now does too, through the one backstop they all share.
 *
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL:
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/auth/inactive-user-login.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { KeyStore } from "../../src/modules/auth";
import {
  appDatabaseFor,
  assignRole,
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
import type { TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | undefined;
let sql: Sql;
let keyStore: KeyStore;
let schoolId: string;

async function asAdmin<T>(run: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return run(tx as unknown as Sql);
  }) as Promise<T>;
}

async function setStatus(userId: string, status: "active" | "suspended" | "archived") {
  await asAdmin(
    (tx) => tx`UPDATE app.users SET status = ${status}::app.user_status WHERE id = ${userId}::uuid`,
  );
}

/** A staff user who signs in with Microsoft, and an app that verifies their ID token. */
async function oauthUser(role = ROLES.INSTRUCTOR) {
  const user = await createUser(sql, schoolId);
  await assignRole(sql, schoolId, user.id, role);
  const subject = `sub-${crypto.randomUUID()}`;
  await asAdmin(
    (tx) => tx`
      INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
      VALUES (${schoolId}, ${user.id}, 'microsoft', ${subject})
    `,
  );
  const app = createApp({
    idTokenLoginEnabled: true,
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    database: appDatabaseFor(sql),
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
    microsoftIdentityVerifier: () => Promise.resolve({ subject, email: user.email }),
  });
  return { user, app };
}

function login(app: OpenAPIHono<AppEnv>): Promise<Response> {
  return Promise.resolve(
    app.request("/api/auth/login/oauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: "stub-id-token", nonce: "stub-nonce", channel: "api" }),
    }),
  );
}

function refresh(app: OpenAPIHono<AppEnv>, token: string): Promise<Response> {
  return Promise.resolve(
    app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: token, channel: "api" }),
    }),
  );
}

async function familyRevoked(familyId: string): Promise<boolean> {
  const rows = await asAdmin(
    (tx) => tx<{ live: number }[]>`
      SELECT count(*)::int AS live FROM app.refresh_tokens
      WHERE family_id = ${familyId}::uuid AND revoked_at IS NULL AND rotated_at IS NULL
    `,
  );
  return rows[0]!.live === 0;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;
  const school = await createSchool(sql, { name: "Inactive Users Academy" });
  schoolId = school.id;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`UPDATE app.schools SET status = 'active'::app.school_status WHERE id = ${schoolId}`;
  });
  keyStore = new KeyStore(60_000);
  await keyStore.init();
  resetSecurityConfig();
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

describe("inactive users get no session (QA-010)", () => {
  integrationTest("an active user signs in (control)", async () => {
    const { app } = await oauthUser();
    expect((await login(app)).status).toBe(200);
  });

  for (const status of ["suspended", "archived"] as const) {
    integrationTest(`a ${status} user cannot sign in with an OAuth identity`, async () => {
      const { user, app } = await oauthUser();
      await setStatus(user.id, status);
      const response = await login(app);
      expect(response.status).toBe(401);
    });
  }

  integrationTest("reactivating the user lets them sign in again", async () => {
    const { user, app } = await oauthUser();
    await setStatus(user.id, "suspended");
    expect((await login(app)).status).toBe(401);
    await setStatus(user.id, "active");
    expect((await login(app)).status).toBe(200);
  });

  integrationTest(
    "a suspended user's refresh token stops working and its family is revoked",
    async () => {
      const { user, app } = await oauthUser();
      const session = await createRefreshSession(sql, schoolId, user.id, { channel: "api" });
      await setStatus(user.id, "suspended");

      expect((await refresh(app, session.token)).status).toBe(401);
      expect(await familyRevoked(session.familyId)).toBe(true);
    },
  );

  integrationTest("PATCH /api/users/{id} to suspended ends the user's sessions", async () => {
    const { user, app } = await oauthUser();
    const admin = await createUser(sql, schoolId);
    await assignRole(sql, schoolId, admin.id, ROLES.ORG_ADMIN);
    const session = await createRefreshSession(sql, schoolId, user.id, { channel: "api" });

    const adminToken = await mintTestToken(keyStore, {
      schoolId,
      userId: admin.id,
      roles: [ROLES.ORG_ADMIN],
      channel: "web",
    });
    const patched = await app.request(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(patched.status).toBe(200);

    expect(await familyRevoked(session.familyId)).toBe(true);
    expect((await refresh(app, session.token)).status).toBe(401);
  });
});
