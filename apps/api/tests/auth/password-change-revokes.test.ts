/**
 * QA-024: changing your own password signs out every other session.
 *
 * `changeMemberPassword` only stored the new password and audited it. Someone who shoulder-surfed a
 * student's password and signed in on their own phone kept that session (a 30-day sliding refresh
 * plus a trusted device) after the student changed it. The admin reset already revoked everything.
 * Now a self-service change revokes and denylists every other session, keeps the one that made the
 * change, and forgets every trusted device.
 *
 *   TEST_DATABASE_URL=... TEST_REDIS_URL=... bun test tests/auth/password-change-revokes.test.ts
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
import type { RedisClient } from "../../src/redis";
import type { TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";

const redisUrl = process.env.TEST_REDIS_URL;
const describeIt = integrationEnabled && redisUrl ? describe : describe.skip;

let database: TestDatabase | undefined;
let sql: Sql;
let keyStore: KeyStore;
let redis: RedisClient | undefined;
let app: OpenAPIHono<AppEnv>;
let schoolId: string;
let adminId: string;

function post(path: string, body: unknown, token?: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

interface Session {
  access_token: string;
  refresh_token: string;
  device_token?: string;
}

async function signIn(username: string, password: string, newPassword?: string): Promise<Session> {
  const response = await post("/api/auth/login/member", {
    username,
    password,
    new_password: newPassword,
    channel: "mobile",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Session;
}

/** A student who claimed their account and set `password`. */
async function student(password: string): Promise<{ id: string; code: string }> {
  const user = await createUser(sql, schoolId);
  await assignRole(sql, schoolId, user.id, ROLES.STUDENT);
  const [row] = await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ code: string }[]>`
      SELECT code FROM app.member_codes WHERE user_id = ${user.id} ORDER BY kind LIMIT 1
    `;
  });
  const admin = await mintTestToken(keyStore, {
    schoolId,
    userId: adminId,
    channel: AUTH_CHANNELS.WEB,
  });
  const reset = await post(`/api/users/${user.id}/password/reset`, {}, admin);
  const { setup_code } = (await reset.json()) as { setup_code: string };
  await signIn(row!.code, setup_code, password);
  return { id: user.id, code: row!.code };
}

const refresh = (session: Session) =>
  post("/api/auth/refresh", { refresh_token: session.refresh_token });

async function sessionsStatus(session: Session): Promise<number> {
  const response = await app.request("/api/auth/sessions", {
    headers: { authorization: `Bearer ${session.access_token}` },
  });
  return response.status;
}

async function trustedDevices(userId: string): Promise<number> {
  const [row] = await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.member_trusted_devices WHERE user_id = ${userId}
    `;
  });
  return row!.n;
}

beforeAll(async () => {
  if (!integrationEnabled || !redisUrl) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;
  const school = await createSchool(sql, { name: "Password Change Academy" });
  schoolId = school.id;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`UPDATE app.schools SET status = 'active'::app.school_status WHERE id = ${schoolId}`;
  });
  const admin = await createUser(sql, schoolId);
  await assignRole(sql, schoolId, admin.id, ROLES.ORG_ADMIN);
  adminId = admin.id;
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

describeIt("a member's own password change (QA-024)", () => {
  test("signs out the other session and keeps the one that made the change", async () => {
    const { id, code } = await student("First-Pass-1");
    const mine = await signIn(code, "First-Pass-1");
    const intruder = await signIn(code, "First-Pass-1");
    expect(await trustedDevices(id)).toBeGreaterThan(0);

    const changed = await post(
      "/api/auth/password/change",
      { current_password: "First-Pass-1", new_password: "Second-Pass-2" },
      mine.access_token,
    );
    expect(changed.status).toBe(200);

    // The intruder: the access token is denylisted at once, and the refresh token is dead.
    expect(await sessionsStatus(intruder)).toBe(401);
    expect((await refresh(intruder)).status).toBe(401);

    // The member's own session carries on.
    expect(await sessionsStatus(mine)).toBe(200);
    expect((await refresh(mine)).status).toBe(200);

    // No device keeps a way around the lockout.
    expect(await trustedDevices(id)).toBe(0);
  });

  test("a rejected change (wrong current password) revokes nothing", async () => {
    const { code } = await student("Keep-Pass-1");
    const mine = await signIn(code, "Keep-Pass-1");
    const other = await signIn(code, "Keep-Pass-1");
    const rejected = await post(
      "/api/auth/password/change",
      { current_password: "wrong", new_password: "Other-Pass-2" },
      mine.access_token,
    );
    expect(rejected.status).toBe(403);
    expect(await sessionsStatus(other)).toBe(200);
  });
});
