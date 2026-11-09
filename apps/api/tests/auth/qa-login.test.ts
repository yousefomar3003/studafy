import { ROLES } from "@studafy/constants";
import { afterAll, beforeAll, describe, expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { KeyStore, QA_LOGIN_PROVIDER, REVIEW_LOGIN_PROVIDER } from "../../src/modules/auth";
import {
  assignRole,
  createSchool,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";

import type { AppEnv } from "../../src/middleware";
import type { TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Role } from "@studafy/constants";
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

const LOGIN_PATH = "/api/auth/login/qa";
const QA_PASSWORD = "qa-password-for-tests-0123456789";

let database: TestDatabase | undefined;
let sql: Sql;
let keyStore: KeyStore;
let app: OpenAPIHono<AppEnv>;
let platformSchoolId: string;
let schoolAId: string;
let schoolBId: string;
let regularSchoolId: string;
let reviewSchoolId: string;

function buildApp(qaLoginPassword: string | undefined): OpenAPIHono<AppEnv> {
  return createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    database: sql,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
    qaLoginPassword,
    // The suite signs in more often than one IP's `auth` budget allows; the limiter has its own tests.
    rateLimitDisabled: true,
  });
}

async function asAdmin<T>(schoolId: string, run: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return run(tx as unknown as Sql);
  }) as Promise<T>;
}

/** A user in `schoolId` holding `role`, with a login identity under `provider` keyed by its email. */
async function account(
  schoolId: string,
  role: Role,
  provider = QA_LOGIN_PROVIDER,
): Promise<string> {
  const email = `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@qa.studafy.test`;
  const user = await createUser(sql, schoolId, { email });
  await assignRole(sql, schoolId, user.id, role);
  await asAdmin(schoolId, async (tx) => {
    await tx`
      INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
      VALUES (${schoolId}, ${user.id}, ${provider}, ${email})
    `;
  });
  return email;
}

function login(email: string, password: string, channel = "api"): Promise<Response> {
  return Promise.resolve(
    app.request(LOGIN_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, channel }),
    }),
  );
}

async function expectInvalidCredentials(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  const problem = (await response.json()) as Record<string, unknown>;
  expect(problem.code).toBe("AUTH_INVALID_CREDENTIALS");
  expect(problem.detail).toBe("Invalid email or password.");
}

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;

  platformSchoolId = (await createSchool(sql, { name: "QA Platform" })).id;
  schoolAId = (await createSchool(sql, { name: "QA School A" })).id;
  schoolBId = (await createSchool(sql, { name: "QA School B" })).id;
  regularSchoolId = (await createSchool(sql, { name: "Regular Academy" })).id;
  reviewSchoolId = (await createSchool(sql, { name: "Review Academy" })).id;
  const all = [platformSchoolId, schoolAId, schoolBId, regularSchoolId, reviewSchoolId];
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`UPDATE app.schools SET status = 'active'::app.school_status WHERE id IN ${tx(all)}`;
    await tx`
      UPDATE app.schools SET is_qa_tenant = true
      WHERE id IN ${tx([platformSchoolId, schoolAId, schoolBId])}
    `;
    await tx`UPDATE app.schools SET is_review_tenant = true WHERE id = ${reviewSchoolId}`;
  });

  keyStore = new KeyStore(60_000);
  await keyStore.init();
  resetSecurityConfig();
  app = buildApp(QA_PASSWORD);
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

describe("QA email/password login", () => {
  integrationTest("SUPER_ADMIN in the platform school signs in", async () => {
    const email = await account(platformSchoolId, ROLES.SUPER_ADMIN);
    expect((await login(email, QA_PASSWORD)).status).toBe(200);
  });

  const schoolRoles = [
    ROLES.ORG_ADMIN,
    ROLES.PRINCIPAL,
    ROLES.INSTRUCTOR,
    ROLES.STUDENT,
    ROLES.PARENT,
    ROLES.FINANCE,
    ROLES.ATTENDANCE_OFFICER,
  ];
  for (const [label, schoolId] of [
    ["A", () => schoolAId],
    ["B", () => schoolBId],
  ] as const) {
    for (const role of schoolRoles) {
      integrationTest(`${role} in school ${label} signs in and receives a session`, async () => {
        const email = await account(schoolId(), role);

        const response = await login(email, QA_PASSWORD);

        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.token_type).toBe("Bearer");
        expect(body.access_token).toBeTruthy();
        expect(body.refresh_token).toBeTruthy();

        const [record] = await asAdmin(schoolId(), (tx) =>
          Promise.resolve(tx<{ logged_in: boolean; audited: boolean }[]>`
            SELECT
              (u.last_login_at IS NOT NULL) AS logged_in,
              EXISTS (
                SELECT 1 FROM app.audit_logs a
                WHERE a.actor_id = u.id AND a.action = 'login'
                  AND a.new_values->>'outcome' = 'LOGIN_SUCCESS'
                  AND a.new_values->>'provider' = ${QA_LOGIN_PROVIDER}
              ) AS audited
            FROM app.users u WHERE u.normalized_email = ${email}
          `),
        );
        expect(record).toEqual({ logged_in: true, audited: true });
      });
    }
  }

  integrationTest("the token is scoped to the account's own school", async () => {
    const email = await account(schoolBId, ROLES.ORG_ADMIN);
    const body = (await (await login(email, QA_PASSWORD)).json()) as { access_token: string };
    const [, payload] = body.access_token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(claims)).toContain(schoolBId);
    expect(JSON.stringify(claims)).not.toContain(schoolAId);
  });

  integrationTest("a wrong password is refused", async () => {
    const email = await account(schoolAId, ROLES.ORG_ADMIN);
    await expectInvalidCredentials(await login(email, `${QA_PASSWORD}x`));
  });

  integrationTest("an unknown email is refused identically", async () => {
    await expectInvalidCredentials(await login("nobody@qa.studafy.test", QA_PASSWORD));
  });

  integrationTest("a qa identity outside a QA tenant is refused", async () => {
    const email = await account(regularSchoolId, ROLES.SUPER_ADMIN);
    await expectInvalidCredentials(await login(email, QA_PASSWORD));
  });

  integrationTest("a review identity is not a QA login, even in a QA tenant", async () => {
    const email = await account(schoolAId, ROLES.ORG_ADMIN, REVIEW_LOGIN_PROVIDER);
    await expectInvalidCredentials(await login(email, QA_PASSWORD));
  });

  integrationTest("a school cannot be both a review and a QA tenant", async () => {
    let message = "";
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`UPDATE app.schools SET is_qa_tenant = true WHERE id = ${reviewSchoolId}`;
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ck_schools_qa_tenant_not_review_tenant");
  });

  integrationTest("the route answers 404 when no QA password is configured", async () => {
    const email = await account(schoolAId, ROLES.STUDENT);
    const unconfigured = buildApp(undefined);
    const response = await unconfigured.request(LOGIN_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: QA_PASSWORD }),
    });
    expect(response.status).toBe(404);
  });
});
