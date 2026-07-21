// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { hashInvitationToken, KeyStore } from "../../src/modules/auth";
import { activateAccount } from "../../src/modules/auth/services/activation-service";
import {
  createSchool,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";

import type { AppEnv } from "../../src/middleware";
import type { SessionTokenConfig } from "../../src/modules/auth";
import type { TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Role } from "@studafy/constants";
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const ACTIVATE_PREFIX = "/api/auth/invitations";

let database: TestDatabase | undefined;
let sql: Sql;
let app: OpenAPIHono<AppEnv>;
let keyStore: KeyStore;
let config: SessionTokenConfig;
let activeSchool: { id: string; name: string };

// A mutable seam read by the injected identity verifier: each route test sets the identity the
// "Microsoft" verifier should return before issuing its request.
let nextIdentity: { subject: string; email: string } = { subject: "", email: "" };

interface InvitationSeed {
  token: string;
  email: string;
}

function randomToken(): string {
  return crypto.getRandomValues(new Uint8Array(32)).toHex();
}

async function seedInvitation(
  schoolId: string,
  options: { email?: string; role?: Role } = {},
): Promise<InvitationSeed> {
  const token = randomToken();
  const email = options.email ?? `activate-${crypto.randomUUID()}@example.test`;
  const role = options.role ?? "STUDENT";

  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.invitations (
        school_id, email, normalized_email, role, token_hash, expires_at, created_at
      ) VALUES (
        ${schoolId},
        ${email},
        ${email.toLowerCase().trim()},
        ${role}::app.user_role,
        ${hashInvitationToken(token)}::bytea,
        ${new Date(Date.now() + 24 * 60 * 60 * 1000)},
        ${new Date(Date.now() - 60 * 60 * 1000)}
      )
    `;
  });

  return { token, email };
}

function readAsAdmin<T>(schoolId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

function activateViaHttp(token: string): Promise<Response> {
  return Promise.resolve(
    app.request(`${ACTIVATE_PREFIX}/${token}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: "stub-id-token", nonce: "stub-nonce" }),
    }),
  );
}

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;

  const school = await createSchool(sql, { name: "Activation Academy" });
  activeSchool = { id: school.id, name: "Activation Academy" };
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`UPDATE app.schools SET status = 'active'::app.school_status WHERE id = ${school.id}`;
  });

  keyStore = new KeyStore(60_000);
  await keyStore.init();
  resetSecurityConfig();

  config = {
    keyStore,
    issuer: TEST_JWT_ISSUER,
    audience: TEST_JWT_AUDIENCE,
    accessTtlSeconds: 900,
    refreshTtlSeconds: 30 * 24 * 60 * 60,
  };

  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    database: sql,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
    microsoftIdentityVerifier: (_idToken, _nonce) => Promise.resolve(nextIdentity),
  });
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

describe("account activation", () => {
  integrationTest(
    "under concurrent duplicate submissions, exactly one activation succeeds",
    async () => {
      const { token, email } = await seedInvitation(activeSchool.id);
      const identity = {
        provider: "microsoft" as const,
        subject: `sub-${crypto.randomUUID()}`,
        email,
      };

      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          activateAccount(sql, config, {
            rawToken: token,
            identity,
            channel: "web",
          }),
        ),
      );

      const activated = attempts.filter(
        (a): a is PromiseFulfilledResult<Awaited<ReturnType<typeof activateAccount>>> =>
          a.status === "fulfilled" && a.value.outcome === "ACTIVATED",
      );
      const rejected = attempts.filter((a) => a.status === "rejected");

      // Exactly one winner; every other attempt fails cleanly as CONSUMED.
      expect(activated).toHaveLength(1);
      expect(rejected).toHaveLength(7);
      for (const failure of rejected) {
        const error = (failure as PromiseRejectedResult).reason as {
          status?: number;
          code?: string;
        };
        expect(error.status).toBe(409);
        expect(error.code).toBe("CONSUMED");
      }

      // No orphaned identity rows: exactly one identity, one active user, invitation consumed once.
      const state = await readAsAdmin(activeSchool.id, async (tx) => {
        const [ident] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.oauth_identities WHERE subject = ${identity.subject}
        `;
        const [user] = await tx<{ status: string }[]>`
          SELECT status FROM app.users WHERE normalized_email = ${email}
        `;
        const [invite] = await tx<{ consumed: boolean }[]>`
          SELECT consumed_at IS NOT NULL AS consumed FROM app.invitations
          WHERE token_hash = ${hashInvitationToken(token)}::bytea
        `;
        return {
          identityCount: Number(ident!.count),
          userStatus: user!.status,
          consumed: invite!.consumed,
        };
      });

      expect(state.identityCount).toBe(1);
      expect(state.userStatus).toBe("active");
      expect(state.consumed).toBe(true);
    },
  );

  integrationTest(
    "email mismatch transitions to REQUIRES_ADMIN_APPROVAL without consuming the invitation",
    async () => {
      const { token } = await seedInvitation(activeSchool.id, { email: "bound@example.test" });
      nextIdentity = { subject: `sub-${crypto.randomUUID()}`, email: "someone-else@example.test" };

      const response = await activateViaHttp(token);

      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(await response.json()).toMatchObject({
        code: "REQUIRES_ADMIN_APPROVAL",
        request_id: response.headers.get("x-request-id"),
      });

      const state = await readAsAdmin(activeSchool.id, async (tx) => {
        const [invite] = await tx<{ consumed: boolean }[]>`
          SELECT consumed_at IS NOT NULL AS consumed FROM app.invitations
          WHERE token_hash = ${hashInvitationToken(token)}::bytea
        `;
        const [anomaly] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.audit_logs
          WHERE action = 'permission_change' AND target_table = 'invitations'
            AND new_values->>'reason' = 'oauth_email_mismatch'
        `;
        return { consumed: invite!.consumed, anomalies: Number(anomaly!.count) };
      });

      // Invitation is left usable; the anomaly is recorded in the audit trail.
      expect(state.consumed).toBe(false);
      expect(state.anomalies).toBeGreaterThanOrEqual(1);
    },
  );

  integrationTest(
    "full lifecycle: links identity, activates user, consumes invitation, issues first session",
    async () => {
      const { token, email } = await seedInvitation(activeSchool.id, { role: "INSTRUCTOR" });
      const subject = `sub-${crypto.randomUUID()}`;
      nextIdentity = { subject, email };

      const response = await activateViaHttp(token);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        access_token: string;
        token_type: string;
        session_id: string;
        refresh_token?: string;
      };
      expect(body.status).toBe("active");
      expect(body.access_token).toBeTruthy();
      expect(body.token_type).toBe("Bearer");
      expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/);
      // Web channel delivers the refresh token as an HttpOnly cookie, not in the body.
      expect(body.refresh_token).toBeUndefined();
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");

      const state = await readAsAdmin(activeSchool.id, async (tx) => {
        const [user] = await tx<{ id: string; status: string }[]>`
          SELECT id, status FROM app.users WHERE normalized_email = ${email}
        `;
        const [ident] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.oauth_identities
          WHERE provider = 'microsoft' AND subject = ${subject} AND user_id = ${user!.id}
        `;
        const [roleRow] = await tx<{ role: string }[]>`
          SELECT role FROM app.user_roles WHERE user_id = ${user!.id}
        `;
        const [invite] = await tx<{ consumed: boolean }[]>`
          SELECT consumed_at IS NOT NULL AS consumed FROM app.invitations
          WHERE token_hash = ${hashInvitationToken(token)}::bytea
        `;
        const [session] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.refresh_tokens WHERE user_id = ${user!.id}
        `;
        const [audit] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.audit_logs WHERE actor_id = ${user!.id}
        `;
        return {
          userStatus: user!.status,
          identityCount: Number(ident!.count),
          role: roleRow!.role,
          consumed: invite!.consumed,
          sessions: Number(session!.count),
          audits: Number(audit!.count),
        };
      });

      expect(state.userStatus).toBe("active");
      expect(state.identityCount).toBe(1);
      expect(state.role).toBe("INSTRUCTOR");
      expect(state.consumed).toBe(true);
      expect(state.sessions).toBe(1);
      expect(state.audits).toBeGreaterThanOrEqual(1);
    },
  );

  integrationTest("re-using a consumed invitation token fails with CONSUMED", async () => {
    const { token, email } = await seedInvitation(activeSchool.id);
    nextIdentity = { subject: `sub-${crypto.randomUUID()}`, email };

    const first = await activateViaHttp(token);
    expect(first.status).toBe(200);

    const second = await activateViaHttp(token);
    expect(second.status).toBe(409);
    expect(second.headers.get("content-type")).toBe("application/problem+json");
    expect(await second.json()).toMatchObject({
      code: "CONSUMED",
      request_id: second.headers.get("x-request-id"),
    });
  });

  integrationTest("a malformed token is the generic INVITATION_INVALID problem", async () => {
    nextIdentity = { subject: "sub", email: "anyone@example.test" };
    const response = await activateViaHttp("not-a-valid-token");

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "INVITATION_INVALID" });
  });
});
