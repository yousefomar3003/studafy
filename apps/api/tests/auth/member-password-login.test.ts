import { ROLES } from "@studafy/constants";
import { afterAll, beforeAll, describe, expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

import { createApp } from "../../src/app";
import { MEMBER_LOGIN_BUDGETS } from "../../src/config/rateLimits";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { KeyStore } from "../../src/modules/auth";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import { SETUP_CODE_TTL_DAYS } from "../../src/modules/auth/services/member-password-service";
import { createRedisClient } from "../../src/redis";
import {
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
import type { Role } from "@studafy/constants";
import type { Sql } from "postgres";

/**
 * Member-ID + password sign-in (000141, 000184): the retired shared default password opens nothing;
 * a member claims their account only with a per-member setup code their school issued, which gives
 * no session until a new password is set and is then spent. Wrong passwords lock the account,
 * privileged accounts are refused, members change their own password, an admin reset issues a new
 * code, and sign-in is rate-limited per member ID regardless of IP (with Redis).
 */

const integrationTest = test.skipIf(!integrationEnabled);
const redisUrl = process.env.TEST_REDIS_URL;
const redisTest = test.skipIf(!integrationEnabled || !redisUrl);
const LOGIN = "/api/auth/login/member";
const CHANGE = "/api/auth/password/change";
const SETUP_CODE_PATTERN =
  /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
/** The password every member used to start with (F-02). */
const RETIRED_DEFAULT_PASSWORD = "pass@1234";

let database: TestDatabase | undefined;
let sql: Sql;
let keyStore: KeyStore;
let app: OpenAPIHono<AppEnv>;
let redis: RedisClient | undefined;
let schoolId: string;
let adminId: string;

async function member(roles: Role[]): Promise<{ id: string; code: string }> {
  const user = await createUser(sql, schoolId);
  for (const role of roles) await assignRole(sql, schoolId, user.id, role);
  const [row] = await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ code: string }[]>`
      SELECT code FROM app.member_codes WHERE user_id = ${user.id} ORDER BY kind LIMIT 1
    `;
  });
  return { id: user.id, code: row!.code };
}

function post(
  path: string,
  body: unknown,
  token?: string,
  target: OpenAPIHono<AppEnv> = app,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    target.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

const login = (username: string, password: string, newPassword?: string) =>
  post(LOGIN, { username, password, new_password: newPassword, channel: "mobile" });

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(((await response.json()) as { code: string }).code).toBe(code);
}

function adminToken(): Promise<string> {
  return mintTestToken(keyStore, { schoolId, userId: adminId, channel: AUTH_CHANNELS.WEB });
}

interface IssuedCode {
  usernames: string[];
  setup_code: string;
  expires_at: string;
}

/** The admin's password reset, which is also how a member gets their first setup code. */
async function issueCode(userId: string): Promise<IssuedCode> {
  const response = await post(`/api/users/${userId}/password/reset`, {}, await adminToken());
  expect(response.status).toBe(200);
  return (await response.json()) as IssuedCode;
}

/** A member who has claimed their account with a setup code and set `password`. */
async function claimed(roles: Role[], password: string): Promise<{ id: string; code: string }> {
  const created = await member(roles);
  const { setup_code } = await issueCode(created.id);
  expect((await login(created.code, setup_code, password)).status).toBe(200);
  return created;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;
  const school = await createSchool(sql, { name: "Password Academy" });
  schoolId = school.id;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`UPDATE app.schools SET status = 'active'::app.school_status WHERE id = ${schoolId}`;
  });
  const admin = await createUser(sql, schoolId);
  await assignRole(sql, schoolId, admin.id, ROLES.ORG_ADMIN);
  adminId = admin.id;

  keyStore = new KeyStore(60_000);
  await keyStore.init();
  resetSecurityConfig();
  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({
      destination: process.env.DEBUG_TEST
        ? (line: string) => process.stderr.write(line)
        : () => undefined,
    }),
    database: sql,
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

describe("member password sign-in", () => {
  integrationTest("the retired default password opens no account", async () => {
    const student = await member([ROLES.STUDENT]);

    // Before F-02 this answered PASSWORD_CHANGE_REQUIRED and, with new_password, a session.
    await expectCode(
      await login(student.code, RETIRED_DEFAULT_PASSWORD),
      401,
      "AUTH_INVALID_CREDENTIALS",
    );
    await expectCode(
      await login(student.code, RETIRED_DEFAULT_PASSWORD, "Attacker-Pass-1"),
      401,
      "AUTH_INVALID_CREDENTIALS",
    );

    // Still nothing after the admin issues a code: only that code works, not the old default.
    await issueCode(student.id);
    await expectCode(
      await login(student.code, RETIRED_DEFAULT_PASSWORD, "Attacker-Pass-1"),
      401,
      "AUTH_INVALID_CREDENTIALS",
    );
  });

  integrationTest("a setup code gives no session until a new password is set", async () => {
    const student = await member([ROLES.STUDENT]);
    const issued = await issueCode(student.id);
    expect(issued.usernames).toEqual([student.code]);
    expect(issued.setup_code).toMatch(SETUP_CODE_PATTERN);
    const ttlDays = (Date.parse(issued.expires_at) - Date.now()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(SETUP_CODE_TTL_DAYS - 0.01);
    expect(ttlDays).toBeLessThanOrEqual(SETUP_CODE_TTL_DAYS);

    await expectCode(
      await login(student.code, issued.setup_code),
      403,
      "AUTH_PASSWORD_CHANGE_REQUIRED",
    );
    await expectCode(
      await login(student.code, issued.setup_code, issued.setup_code.toLowerCase()),
      422,
      "AUTH_PASSWORD_REJECTED",
    );
    await expectCode(
      await login(student.code, issued.setup_code, "short"),
      422,
      "AUTH_PASSWORD_REJECTED",
    );

    // Case and dashes are ignored when typing the code.
    const typed = issued.setup_code.replace(/-/g, "").toLowerCase();
    const first = await login(student.code.toLowerCase(), typed, "Blue-Kite-42");
    expect(first.status).toBe(200);
    const body = (await first.json()) as { access_token: string; refresh_token?: string };
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();

    // The code is spent; the new password works with no further change asked.
    await expectCode(await login(student.code, issued.setup_code), 401, "AUTH_INVALID_CREDENTIALS");
    await expectCode(
      await login(student.code, issued.setup_code, "Other-Pass-77"),
      401,
      "AUTH_INVALID_CREDENTIALS",
    );
    expect((await login(student.code, "Blue-Kite-42")).status).toBe(200);
  });

  integrationTest("an expired setup code is refused", async () => {
    const parent = await member([ROLES.PARENT]);
    const { setup_code } = await issueCode(parent.id);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
      await tx`
        UPDATE app.member_credentials
        SET setup_code_expires_at = CURRENT_TIMESTAMP - interval '1 second'
        WHERE user_id = ${parent.id}
      `;
    });
    await expectCode(await login(parent.code, setup_code), 401, "AUTH_INVALID_CREDENTIALS");
  });

  integrationTest("five wrong passwords lock the account, even against the right one", async () => {
    const parent = await member([ROLES.PARENT]);
    const { setup_code } = await issueCode(parent.id);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expectCode(await login(parent.code, "wrong-guess"), 401, "AUTH_INVALID_CREDENTIALS");
    }
    await expectCode(await login(parent.code, "wrong-guess"), 403, "AUTH_ACCOUNT_LOCKED");
    await expectCode(await login(parent.code, setup_code), 403, "AUTH_ACCOUNT_LOCKED");
  });

  integrationTest("unknown IDs and privileged accounts are refused the same way", async () => {
    await expectCode(await login("STU-999900001", "Any-Pass-123"), 401, "AUTH_INVALID_CREDENTIALS");
    // A principal who also teaches keeps Google / Microsoft sign-in only, even with a setup code.
    const principal = await member([ROLES.INSTRUCTOR, ROLES.PRINCIPAL]);
    const { setup_code } = await issueCode(principal.id);
    await expectCode(await login(principal.code, setup_code), 401, "AUTH_INVALID_CREDENTIALS");
  });

  integrationTest("a signed-in member changes their own password", async () => {
    const officer = await member([ROLES.ATTENDANCE_OFFICER]);
    expect(officer.code.startsWith("ATT-")).toBe(true);
    const { setup_code } = await issueCode(officer.id);
    const signedIn = await login(officer.code, setup_code, "First-Pass-1");
    const { access_token: token } = (await signedIn.json()) as { access_token: string };

    await expectCode(
      await post(CHANGE, { current_password: "nope", new_password: "Second-Pass-2" }, token),
      403,
      "AUTH_INVALID_CREDENTIALS",
    );
    const changed = await post(
      CHANGE,
      { current_password: "First-Pass-1", new_password: "Second-Pass-2" },
      token,
    );
    expect(changed.status).toBe(200);
    expect((await login(officer.code, "Second-Pass-2")).status).toBe(200);
  });

  integrationTest("an admin reset issues a new one-time code, not a shared default", async () => {
    const teacher = await claimed([ROLES.INSTRUCTOR], "Teach-Pass-9");

    const response = await post(`/api/users/${teacher.id}/password/reset`, {}, await adminToken());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reset = (await response.json()) as IssuedCode & Record<string, unknown>;
    expect(reset.usernames).toEqual([teacher.code]);
    expect(reset.setup_code).toMatch(SETUP_CODE_PATTERN);
    expect(reset).not.toHaveProperty("default_password");

    // Each reset is a fresh secret; the previous one stops working.
    const again = await issueCode(teacher.id);
    expect(again.setup_code).not.toBe(reset.setup_code);
    await expectCode(await login(teacher.code, reset.setup_code), 401, "AUTH_INVALID_CREDENTIALS");

    await expectCode(await login(teacher.code, "Teach-Pass-9"), 401, "AUTH_INVALID_CREDENTIALS");
    await expectCode(
      await login(teacher.code, RETIRED_DEFAULT_PASSWORD),
      401,
      "AUTH_INVALID_CREDENTIALS",
    );
    await expectCode(
      await login(teacher.code, again.setup_code),
      403,
      "AUTH_PASSWORD_CHANGE_REQUIRED",
    );
  });

  integrationTest("bulk issue reaches only members who cannot sign in yet", async () => {
    const unclaimedA = await member([ROLES.STUDENT]);
    const unclaimedB = await member([ROLES.STUDENT]);
    const signedUp = await claimed([ROLES.STUDENT], "Has-A-Pass-1");
    const token = await adminToken();

    const first = await post("/api/users/member-setup-codes", { role: "STUDENT" }, token);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const batch = (await first.json()) as {
      issued: (IssuedCode & { user_id: string })[];
      remaining: number;
    };
    const ids = batch.issued.map((row) => row.user_id);
    expect(ids).toContain(unclaimedA.id);
    expect(ids).toContain(unclaimedB.id);
    expect(ids).not.toContain(signedUp.id);
    expect(batch.remaining).toBe(0);

    // A second run leaves the sheet already handed out valid.
    const second = (await (
      await post("/api/users/member-setup-codes", { role: "STUDENT" }, token)
    ).json()) as { issued: { user_id: string }[] };
    expect(second.issued.map((row) => row.user_id)).not.toContain(unclaimedA.id);

    const codeA = batch.issued.find((row) => row.user_id === unclaimedA.id)!;
    expect(codeA.usernames).toEqual([unclaimedA.code]);
    await expectCode(
      await login(unclaimedA.code, codeA.setup_code),
      403,
      "AUTH_PASSWORD_CHANGE_REQUIRED",
    );
    // The signed-up member was not signed out or reset.
    expect((await login(signedUp.code, "Has-A-Pass-1")).status).toBe(200);
  });

  integrationTest("the member summary no longer publishes a password", async () => {
    const response = await app.request("/api/users/member-summary", {
      headers: { authorization: `Bearer ${await adminToken()}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("default_password");
  });

  redisTest("sign-in attempts on one member ID are limited whatever the IP", async () => {
    const logger = createLogger({ destination: () => undefined });
    redis = createRedisClient({ url: redisUrl!, logger });
    const limited = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger,
      database: sql,
      redis,
      keyStore,
      jwtIssuer: TEST_JWT_ISSUER,
      jwtAudience: TEST_JWT_AUDIENCE,
    });
    // Unknown IDs have no lockout, so only the rate limit stops guessing at them.
    const target = `STU-9${Date.now() % 100_000_000}`;
    const attempt = (n: number) =>
      post(LOGIN, { username: target, password: `guess-${n}` }, undefined, limited, {
        // A fresh address each time, so the per-IP limit never engages.
        "x-forwarded-for": `198.51.100.${n % 250}`,
      });

    for (let n = 0; n < MEMBER_LOGIN_BUDGETS.username.maxTokens; n += 1) {
      expect((await attempt(n)).status).toBe(401);
    }
    const blocked = await attempt(MEMBER_LOGIN_BUDGETS.username.maxTokens);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // Another member ID from the same addresses is unaffected.
    const other = await post(
      LOGIN,
      { username: `PAR-9${Date.now() % 100_000_000}`, password: "guess" },
      undefined,
      limited,
      { "x-forwarded-for": "203.0.113.7" },
    );
    expect(other.status).toBe(401);
  });
});
