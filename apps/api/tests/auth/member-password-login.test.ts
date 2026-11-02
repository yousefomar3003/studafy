import { ROLES } from "@studafy/constants";
import { afterAll, beforeAll, describe, expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { KeyStore } from "../../src/modules/auth";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import { DEFAULT_MEMBER_PASSWORD } from "../../src/modules/auth/services/member-password-service";
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
import type { TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Role } from "@studafy/constants";
import type { Sql } from "postgres";

/**
 * Member-ID + password sign-in (000141): the default password never yields a session, a new one is
 * required in the same request, wrong passwords lock the account, privileged accounts are refused,
 * members change their own password, and an admin reset returns them to the default.
 */

const integrationTest = test.skipIf(!integrationEnabled);
const LOGIN = "/api/auth/login/member";
const CHANGE = "/api/auth/password/change";

let database: TestDatabase | undefined;
let sql: Sql;
let keyStore: KeyStore;
let app: OpenAPIHono<AppEnv>;
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

const login = (username: string, password: string, newPassword?: string) =>
  post(LOGIN, { username, password, new_password: newPassword, channel: "mobile" });

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(((await response.json()) as { code: string }).code).toBe(code);
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
  await database?.cleanup();
});

describe("member password sign-in", () => {
  integrationTest("the default password gives no session until a new password is set", async () => {
    const student = await member([ROLES.STUDENT]);

    await expectCode(
      await login(student.code, DEFAULT_MEMBER_PASSWORD),
      403,
      "AUTH_PASSWORD_CHANGE_REQUIRED",
    );
    await expectCode(
      await login(student.code, DEFAULT_MEMBER_PASSWORD, DEFAULT_MEMBER_PASSWORD),
      422,
      "AUTH_PASSWORD_REJECTED",
    );
    await expectCode(
      await login(student.code, DEFAULT_MEMBER_PASSWORD, "short"),
      422,
      "AUTH_PASSWORD_REJECTED",
    );

    const first = await login(student.code.toLowerCase(), DEFAULT_MEMBER_PASSWORD, "Blue-Kite-42");
    expect(first.status).toBe(200);
    const body = (await first.json()) as { access_token: string; refresh_token?: string };
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();

    // The default no longer works; the new password does, with no further change asked.
    await expectCode(
      await login(student.code, DEFAULT_MEMBER_PASSWORD),
      401,
      "AUTH_INVALID_CREDENTIALS",
    );
    expect((await login(student.code, "Blue-Kite-42")).status).toBe(200);
  });

  integrationTest("five wrong passwords lock the account, even against the right one", async () => {
    const parent = await member([ROLES.PARENT]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expectCode(await login(parent.code, "wrong-guess"), 401, "AUTH_INVALID_CREDENTIALS");
    }
    await expectCode(await login(parent.code, "wrong-guess"), 403, "AUTH_ACCOUNT_LOCKED");
    await expectCode(await login(parent.code, DEFAULT_MEMBER_PASSWORD), 403, "AUTH_ACCOUNT_LOCKED");
  });

  integrationTest("unknown IDs and privileged accounts are refused the same way", async () => {
    await expectCode(
      await login("STU-999900001", DEFAULT_MEMBER_PASSWORD),
      401,
      "AUTH_INVALID_CREDENTIALS",
    );
    // A principal who also teaches keeps Google / Microsoft sign-in only.
    const principal = await member([ROLES.INSTRUCTOR, ROLES.PRINCIPAL]);
    await expectCode(
      await login(principal.code, DEFAULT_MEMBER_PASSWORD),
      401,
      "AUTH_INVALID_CREDENTIALS",
    );
  });

  integrationTest("a signed-in member changes their own password", async () => {
    const officer = await member([ROLES.ATTENDANCE_OFFICER]);
    expect(officer.code.startsWith("ATT-")).toBe(true);
    const signedIn = await login(officer.code, DEFAULT_MEMBER_PASSWORD, "First-Pass-1");
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

  integrationTest("an admin reset returns the member to the default password", async () => {
    const teacher = await member([ROLES.INSTRUCTOR]);
    expect((await login(teacher.code, DEFAULT_MEMBER_PASSWORD, "Teach-Pass-9")).status).toBe(200);

    const adminToken = await mintTestToken(keyStore, {
      schoolId,
      userId: adminId,
      channel: AUTH_CHANNELS.WEB,
    });
    const reset = await post(`/api/users/${teacher.id}/password/reset`, {}, adminToken);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({
      usernames: [teacher.code],
      default_password: DEFAULT_MEMBER_PASSWORD,
    });

    await expectCode(await login(teacher.code, "Teach-Pass-9"), 401, "AUTH_INVALID_CREDENTIALS");
    await expectCode(
      await login(teacher.code, DEFAULT_MEMBER_PASSWORD),
      403,
      "AUTH_PASSWORD_CHANGE_REQUIRED",
    );
  });
});
