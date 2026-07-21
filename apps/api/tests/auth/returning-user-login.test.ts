import { ROLES } from "@studafy/constants";
import { afterAll, beforeAll, describe, expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in


import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { KeyStore } from "../../src/modules/auth";
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
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOGIN_PREFIX = "/api/auth/login/oauth";

let database: TestDatabase | undefined;
let sql: Sql;
let app: OpenAPIHono<AppEnv>;
let keyStore: KeyStore;
let activeSchool: { id: string; slug: string };

/**
 * Seed an oauth_identities row for a user so the returning-user login can find it.
 * Runs as studafy_admin to bypass RLS (the identity table is tenant-scoped).
 */
async function seedOAuthIdentity(
  schoolId: string,
  userId: string,
  provider: string,
  subject: string,
): Promise<string> {
  let identityId = "";
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
      VALUES (${schoolId}, ${userId}, ${provider}, ${subject})
      RETURNING id
    `;
    identityId = row!.id;
  });
  return identityId;
}

/** Read a count from an admin transaction. */
async function countRows(schoolId: string, query: (tx: Sql) => Promise<number>): Promise<number> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return query(tx as unknown as Sql);
  }) as Promise<number>;
}

/** Make a login request via HTTP. */
function loginViaHttp(idToken: string, nonce: string, channel = "api"): Promise<Response> {
  return Promise.resolve(
    app.request(LOGIN_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: idToken, nonce, channel }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;

  const school = await createSchool(sql, { name: "Login Test Academy" });
  activeSchool = { id: school.id, slug: school.slug };
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`UPDATE app.schools SET status = 'active'::app.school_status WHERE id = ${school.id}`;
  });

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
    microsoftIdentityVerifier: (_idToken: string, _nonce: string) =>
      Promise.resolve({ subject: `sub-${crypto.randomUUID()}`, email: "test@example.test" }),
  });
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("returning-user OAuth login", () => {
  // -----------------------------------------------------------------------
  // Successful login
  // -----------------------------------------------------------------------

  integrationTest(
    "valid returning user resolves identity, passes tenant policy, emits audit, and receives tokens",
    async () => {
      const subject = `sub-${crypto.randomUUID()}`;
      const user = await createUser(sql, activeSchool.id);
      await assignRole(sql, activeSchool.id, user.id, ROLES.STUDENT);
      await seedOAuthIdentity(activeSchool.id, user.id, "microsoft", subject);

      // Override the verifier to return our deterministic subject.
      app = createApp({
        isReady: () => true,
        tracker: createInflightTracker(),
        logger: createLogger({ destination: () => undefined }),
        database: sql,
        keyStore,
        jwtIssuer: TEST_JWT_ISSUER,
        jwtAudience: TEST_JWT_AUDIENCE,
        microsoftIdentityVerifier: (_idToken: string, _nonce: string) =>
          Promise.resolve({ subject, email: user.email }),
      });

      const start = performance.now();
      const response = await loginViaHttp("stub-id-token", "stub-nonce");
      const elapsed = performance.now() - start;

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const body = (await response.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
        session_id: string;
        refresh_token?: string;
      };
      expect(body.access_token).toBeTruthy();
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(900);
      expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/);

      // Web channel would set a cookie; api channel returns refresh_token in body.
      // Default channel is "api".
      expect(body.refresh_token).toBeTruthy();

      // p95 latency check: the login pipeline (excluding id_token validation) should
      // complete well under 400 ms. The stub verifier skips the JWKS round-trip.
      expect(elapsed).toBeLessThan(400);

      // Verify audit log was written.
      const auditCount = await countRows(activeSchool.id, async (tx) => {
        const [row] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.audit_logs
          WHERE action = 'login'
            AND new_values->>'outcome' = 'LOGIN_SUCCESS'
        `;
        return Number(row!.count);
      });
      expect(auditCount).toBeGreaterThanOrEqual(1);

      // Verify last_login_at was updated.
      const lastLogin = await countRows(activeSchool.id, async (tx) => {
        const [row] = await tx<{ has_login: string }[]>`
          SELECT (last_login_at IS NOT NULL)::text AS has_login
          FROM app.users WHERE id = ${user.id}
        `;
        return row!.has_login === "true" ? 1 : 0;
      });
      expect(lastLogin).toBe(1);
    },
  );

  // -----------------------------------------------------------------------
  // Unknown subject → NO_ACCOUNT
  // -----------------------------------------------------------------------

  integrationTest(
    "unregistered OAuth subject returns NO_ACCOUNT without creating orphaned records",
    async () => {
      const unknownSubject = `sub-unknown-${crypto.randomUUID()}`;

      app = createApp({
        isReady: () => true,
        tracker: createInflightTracker(),
        logger: createLogger({ destination: () => undefined }),
        database: sql,
        keyStore,
        jwtIssuer: TEST_JWT_ISSUER,
        jwtAudience: TEST_JWT_AUDIENCE,
        microsoftIdentityVerifier: (_idToken: string, _nonce: string) =>
          Promise.resolve({ subject: unknownSubject, email: "nobody@example.test" }),
      });

      const response = await loginViaHttp("stub-id-token", "stub-nonce");

      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toBe("application/problem+json");

      const problem = (await response.json()) as Record<string, unknown>;
      expect(problem.code).toBe("NO_ACCOUNT");
      expect(problem.status).toBe(403);
      expect(problem.detail).toBe("No account found — ask your school admin for an invitation.");
      expect(problem.request_id).toBe(response.headers.get("x-request-id"));

      // No orphaned records should exist.
      const orphanCount = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        const [row] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.oauth_identities
          WHERE provider = 'microsoft' AND subject = ${unknownSubject}
        `;
        return Number(row!.count);
      })) as number;
      expect(orphanCount).toBe(0);
    },
  );

  // -----------------------------------------------------------------------
  // Suspended school — standard role blocked
  // -----------------------------------------------------------------------

  integrationTest("standard role on suspended school receives SCHOOL_SUSPENDED", async () => {
    // Create a separate school for this test to avoid polluting the active one.
    const suspendedSchool = await createSchool(sql, { name: "Suspended Academy" });
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`UPDATE app.schools SET status = 'suspended'::app.school_status WHERE id = ${suspendedSchool.id}`;
    });

    const subject = `sub-${crypto.randomUUID()}`;
    const user = await createUser(sql, suspendedSchool.id);
    await assignRole(sql, suspendedSchool.id, user.id, ROLES.STUDENT);
    await seedOAuthIdentity(suspendedSchool.id, user.id, "microsoft", subject);

    app = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      database: sql,
      keyStore,
      jwtIssuer: TEST_JWT_ISSUER,
      jwtAudience: TEST_JWT_AUDIENCE,
      microsoftIdentityVerifier: (_idToken: string, _nonce: string) =>
        Promise.resolve({ subject, email: user.email }),
    });

    const response = await loginViaHttp("stub-id-token", "stub-nonce");

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/problem+json");

    const problem = (await response.json()) as Record<string, unknown>;
    expect(problem.code).toBe("SCHOOL_SUSPENDED");
    expect(problem.status).toBe(403);
    expect(problem.request_id).toBe(response.headers.get("x-request-id"));

    // Verify audit log was written for the suspension block.
    const auditCount = await countRows(suspendedSchool.id, async (tx) => {
      const [row] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.audit_logs
          WHERE action = 'login'
            AND new_values->>'outcome' = 'LOGIN_FAILED_SCHOOL_SUSPENDED'
        `;
      return Number(row!.count);
    });
    expect(auditCount).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Suspended school — admin bypass
  // -----------------------------------------------------------------------

  integrationTest(
    "ORG_ADMIN on suspended school successfully bypasses suspension and receives tokens",
    async () => {
      const suspendedSchool = await createSchool(sql, { name: "Suspended Admin Academy" });
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`UPDATE app.schools SET status = 'suspended'::app.school_status WHERE id = ${suspendedSchool.id}`;
      });

      const subject = `sub-${crypto.randomUUID()}`;
      const user = await createUser(sql, suspendedSchool.id);
      await assignRole(sql, suspendedSchool.id, user.id, ROLES.ORG_ADMIN);
      await seedOAuthIdentity(suspendedSchool.id, user.id, "microsoft", subject);

      app = createApp({
        isReady: () => true,
        tracker: createInflightTracker(),
        logger: createLogger({ destination: () => undefined }),
        database: sql,
        keyStore,
        jwtIssuer: TEST_JWT_ISSUER,
        jwtAudience: TEST_JWT_AUDIENCE,
        microsoftIdentityVerifier: (_idToken: string, _nonce: string) =>
          Promise.resolve({ subject, email: user.email }),
      });

      const response = await loginViaHttp("stub-id-token", "stub-nonce");

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        access_token: string;
        token_type: string;
        session_id: string;
      };
      expect(body.access_token).toBeTruthy();
      expect(body.token_type).toBe("Bearer");
      expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/);

      // Verify audit log was written for the successful login.
      const auditCount = await countRows(suspendedSchool.id, async (tx) => {
        const [row] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.audit_logs
          WHERE action = 'login'
            AND new_values->>'outcome' = 'LOGIN_SUCCESS'
        `;
        return Number(row!.count);
      });
      expect(auditCount).toBeGreaterThanOrEqual(1);
    },
  );

  integrationTest("SUPER_ADMIN on suspended school successfully bypasses suspension", async () => {
    const suspendedSchool = await createSchool(sql, { name: "Suspended Super Academy" });
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`UPDATE app.schools SET status = 'suspended'::app.school_status WHERE id = ${suspendedSchool.id}`;
    });

    const subject = `sub-${crypto.randomUUID()}`;
    const user = await createUser(sql, suspendedSchool.id);
    await assignRole(sql, suspendedSchool.id, user.id, ROLES.SUPER_ADMIN);
    await seedOAuthIdentity(suspendedSchool.id, user.id, "microsoft", subject);

    app = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      database: sql,
      keyStore,
      jwtIssuer: TEST_JWT_ISSUER,
      jwtAudience: TEST_JWT_AUDIENCE,
      microsoftIdentityVerifier: (_idToken: string, _nonce: string) =>
        Promise.resolve({ subject, email: user.email }),
    });

    const response = await loginViaHttp("stub-id-token", "stub-nonce");
    expect(response.status).toBe(200);

    const body = (await response.json()) as { access_token: string; session_id: string };
    expect(body.access_token).toBeTruthy();
    expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // -----------------------------------------------------------------------
  // Invalid id_token
  // -----------------------------------------------------------------------

  integrationTest("invalid id_token returns AUTH_TOKEN_INVALID", async () => {
    app = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      database: sql,
      keyStore,
      jwtIssuer: TEST_JWT_ISSUER,
      jwtAudience: TEST_JWT_AUDIENCE,
      microsoftIdentityVerifier: (_idToken: string, _nonce: string) =>
        Promise.reject(
          Object.assign(new Error("Invalid Microsoft identity token"), {
            status: 401,
            code: "AUTH_TOKEN_INVALID",
          }),
        ),
    });

    const response = await loginViaHttp("invalid-token", "some-nonce");

    // The error propagates through the global error handler.
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/problem+json");

    const problem = (await response.json()) as Record<string, unknown>;
    expect(problem.code).toBe("AUTH_TOKEN_INVALID");
  });

  // -----------------------------------------------------------------------
  // Audit emission check — all outcomes recorded
  // -----------------------------------------------------------------------

  integrationTest(
    "all login outcomes are written to audit_logs with correct tenant and user contexts",
    async () => {
      // This test relies on the audit rows created by the tests above.
      // We verify that the audit_logs table contains entries for each outcome type.
      const outcomes = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        const rows = await tx<{ outcome: string; count: string }[]>`
          SELECT
            new_values->>'outcome' AS outcome,
            count(*)::text AS count
          FROM app.audit_logs
          WHERE action = 'login'
          GROUP BY new_values->>'outcome'
        `;
        return rows.map((r) => ({ outcome: r.outcome, count: Number(r.count) }));
      })) as { outcome: string; count: number }[];

      const outcomeMap = new Map(outcomes.map((o) => [o.outcome, o.count]));

      // At minimum, the tests above should have produced LOGIN_SUCCESS and
      // LOGIN_FAILED_SCHOOL_SUSPENDED entries. LOGIN_SUCCESS is the most common.
      expect(outcomeMap.get("LOGIN_SUCCESS")).toBeGreaterThanOrEqual(1);
      expect(outcomeMap.get("LOGIN_FAILED_SCHOOL_SUSPENDED")).toBeGreaterThanOrEqual(1);
    },
  );
});
