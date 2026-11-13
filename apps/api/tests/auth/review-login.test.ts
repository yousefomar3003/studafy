import { ROLES } from "@studafy/constants";
import { afterAll, beforeAll, describe, expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { KeyStore, REVIEW_LOGIN_PROVIDER } from "../../src/modules/auth";
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

const LOGIN_PATH = "/api/auth/login/review";
const REVIEW_PASSWORD = "review-password-for-tests-0123";

let database: TestDatabase | undefined;
let sql: Sql;
let keyStore: KeyStore;
let app: OpenAPIHono<AppEnv>;
let reviewSchoolId: string;
let regularSchoolId: string;

function buildApp(reviewLoginPassword: string | undefined): OpenAPIHono<AppEnv> {
  return createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    database: sql,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
    reviewLoginPassword,
  });
}

async function asAdmin<T>(schoolId: string, run: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return run(tx as unknown as Sql);
  }) as Promise<T>;
}

/** A user in `schoolId` holding `role`, with a `review` login identity keyed by its email. */
async function reviewAccount(schoolId: string, role: Role): Promise<string> {
  const email = `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@review.studafy.test`;
  const user = await createUser(sql, schoolId, { email });
  await assignRole(sql, schoolId, user.id, role);
  await asAdmin(schoolId, async (tx) => {
    await tx`
      INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
      VALUES (${schoolId}, ${user.id}, ${REVIEW_LOGIN_PROVIDER}, ${email})
    `;
  });
  return email;
}

function login(email: string, password: string, channel = "mobile"): Promise<Response> {
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

  const reviewSchool = await createSchool(sql, { name: "Review Academy" });
  const regularSchool = await createSchool(sql, { name: "Regular Academy" });
  reviewSchoolId = reviewSchool.id;
  regularSchoolId = regularSchool.id;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`
      UPDATE app.schools SET status = 'active'::app.school_status
      WHERE id IN (${reviewSchoolId}, ${regularSchoolId})
    `;
    await tx`UPDATE app.schools SET is_review_tenant = true WHERE id = ${reviewSchoolId}`;
  });

  keyStore = new KeyStore(60_000);
  await keyStore.init();
  resetSecurityConfig();
  app = buildApp(REVIEW_PASSWORD);
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

describe("review email/password login", () => {
  for (const role of [ROLES.ORG_ADMIN, ROLES.INSTRUCTOR, ROLES.PARENT, ROLES.STUDENT]) {
    integrationTest(`${role} signs in and receives a session`, async () => {
      const email = await reviewAccount(reviewSchoolId, role);

      const response = await login(email, REVIEW_PASSWORD);

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.token_type).toBe("Bearer");
      expect(body.access_token).toBeTruthy();
      expect(body.refresh_token).toBeTruthy();

      // The shared post-authentication path ran: last_login_at stamped and the login audited.
      const [record] = await asAdmin(reviewSchoolId, (tx) =>
        Promise.resolve(tx<{ logged_in: boolean; audited: boolean }[]>`
          SELECT
            (u.last_login_at IS NOT NULL) AS logged_in,
            EXISTS (
              SELECT 1 FROM app.audit_logs a
              WHERE a.actor_id = u.id AND a.action = 'login'
                AND a.new_values->>'outcome' = 'LOGIN_SUCCESS'
                AND a.new_values->>'provider' = ${REVIEW_LOGIN_PROVIDER}
            ) AS audited
          FROM app.users u WHERE u.normalized_email = ${email}
        `),
      );
      expect(record).toEqual({ logged_in: true, audited: true });
    });
  }

  integrationTest("email matching is case- and whitespace-insensitive", async () => {
    const email = await reviewAccount(reviewSchoolId, ROLES.STUDENT);
    const response = await login(`  ${email.toUpperCase()} `, REVIEW_PASSWORD);
    expect(response.status).toBe(200);
  });

  integrationTest("a wrong password is refused", async () => {
    const email = await reviewAccount(reviewSchoolId, ROLES.ORG_ADMIN);
    await expectInvalidCredentials(await login(email, `${REVIEW_PASSWORD}x`));
  });

  integrationTest("an unknown email is refused identically", async () => {
    await expectInvalidCredentials(await login("nobody@review.studafy.test", REVIEW_PASSWORD));
  });

  integrationTest("a review identity outside the review tenant is refused", async () => {
    const email = await reviewAccount(regularSchoolId, ROLES.ORG_ADMIN);
    await expectInvalidCredentials(await login(email, REVIEW_PASSWORD));
  });

  integrationTest("the route answers 404 when no reviewer password is configured", async () => {
    const email = await reviewAccount(reviewSchoolId, ROLES.STUDENT);
    const unconfigured = buildApp(undefined);
    const response = await unconfigured.request(LOGIN_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: REVIEW_PASSWORD }),
    });
    expect(response.status).toBe(404);
  });
});
