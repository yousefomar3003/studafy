/**
 * QA-026: changing a user's role ends the rights their live access tokens still carry.
 *
 * Roles travel in the access token, so `updateUserRole` re-inserting `app.user_roles` left a demoted
 * administrator with their old rights until the token expired (up to 15 minutes). Now the target's
 * live access tokens are denylisted. Their refresh tokens are left alone: the next refresh reads the
 * new roles from the database, so the user stays signed in with what they are now allowed.
 *
 *   TEST_DATABASE_URL=... TEST_REDIS_URL=... bun test tests/auth/role-change-revokes.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { KeyStore } from "../../src/modules/auth";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import { createRedisClient } from "../../src/redis";
import {
  appDatabaseFor,
  assignRole,
  createFullTenant,
  createRefreshSession,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";

import type { AppEnv } from "../../src/middleware";
import type { RedisClient } from "../../src/redis";
import type { TenantFixture, TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Role } from "@studafy/constants";
import type { Sql } from "postgres";

const redisUrl = process.env.TEST_REDIS_URL;
const describeIt = integrationEnabled && redisUrl ? describe : describe.skip;

let database: TestDatabase | undefined;
let sql: Sql;
let keyStore: KeyStore;
let redis: RedisClient | undefined;
let app: OpenAPIHono<AppEnv>;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!integrationEnabled || !redisUrl) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;
  tenant = await createFullTenant(sql);
  const logger = createLogger({ destination: () => undefined });
  redis = createRedisClient({ url: redisUrl, logger });
  keyStore = new KeyStore(60_000);
  await keyStore.init();
  resetSecurityConfig();
  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger,
    database: appDatabaseFor(sql),
    redis,
    rateLimitDisabled: true,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
  });
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  redis?.disconnect();
  await database?.cleanup();
});

/** A user holding `role`, signed in with a real session whose access token the app accepts. */
async function signedIn(role: Role, channel: "web" | "mobile" = "web") {
  const user = await createUser(sql, tenant.schoolId);
  await assignRole(sql, tenant.schoolId, user.id, role);
  const jti = crypto.randomUUID();
  const session = await createRefreshSession(sql, tenant.schoolId, user.id, {
    channel,
    accessJti: jti,
    accessExpiresAt: new Date(Date.now() + 15 * 60_000),
  });
  const bearer = await mintTestToken(keyStore, {
    schoolId: tenant.schoolId,
    userId: user.id,
    roles: [role],
    channel: channel === "web" ? AUTH_CHANNELS.WEB : AUTH_CHANNELS.MOBILE,
    jti,
  });
  return { id: user.id, bearer, refreshToken: session.token };
}

async function adminBearer(): Promise<string> {
  return mintTestToken(keyStore, {
    schoolId: tenant.schoolId,
    userId: tenant.users.ORG_ADMIN.id,
    roles: [ROLES.ORG_ADMIN],
    channel: AUTH_CHANNELS.WEB,
  });
}

const get = (path: string, bearer: string) =>
  Promise.resolve(app.request(path, { headers: { authorization: `Bearer ${bearer}` } }));

describeIt("a role change (QA-026)", () => {
  test("a demoted principal's old access token stops working at once", async () => {
    const principal = await signedIn(ROLES.PRINCIPAL);
    expect((await get("/api/users", principal.bearer)).status).toBe(200);

    const demoted = await app.request(`/api/users/${principal.id}/role`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${await adminBearer()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: ROLES.INSTRUCTOR }),
    });
    expect(demoted.status).toBe(200);

    expect((await get("/api/users", principal.bearer)).status).toBe(401);
  });

  test("the session itself survives: a refresh issues a token with the new role", async () => {
    // Mobile: an instructor's web session is refused by design, whatever the role change.
    const principal = await signedIn(ROLES.PRINCIPAL, "mobile");
    await app.request(`/api/users/${principal.id}/role`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${await adminBearer()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: ROLES.INSTRUCTOR }),
    });
    const refreshed = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: principal.refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    const { access_token } = (await refreshed.json()) as { access_token: string };
    const roles = JSON.parse(Buffer.from(access_token.split(".")[1]!, "base64url").toString())
      .roles as string[];
    expect(roles).toEqual([ROLES.INSTRUCTOR]);
  });

  test("a refused role change leaves the user's tokens alone", async () => {
    const teacher = await signedIn(ROLES.INSTRUCTOR);
    const refused = await app.request(`/api/users/${teacher.id}/role`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${await adminBearer()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: ROLES.SUPER_ADMIN }),
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await get("/api/auth/sessions", teacher.bearer)).status).toBe(200);
  });
});
