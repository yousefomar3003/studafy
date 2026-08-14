import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { jtiDenylistKey, KeyStore } from "../../src/modules/auth";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import { createRedisClient } from "../../src/redis";
import {
  createFullTenant,
  createRefreshSession,
  createTestDatabase,
  createUserDevice,
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

/**
 * ST-072 — logout and device revocation, end to end.
 *
 * The acceptance target is not "the row is marked revoked". It is that a revoked credential stops
 * working *everywhere*, quickly. So the questions this file asks are deliberately behavioural: after
 * a logout, does the access token still open a protected endpoint on a different API instance? Does
 * a revoked device's refresh token still rotate? Can an administrator in one tenant reach into
 * another?
 *
 * TWO APPS, ONE REDIS. `app` and `peerApp` are separate createApp instances sharing a database and a
 * Redis connection, standing in for two API pods behind a load balancer. Asserting the denylist on
 * the *same* instance that performed the revocation would prove almost nothing — it would be
 * consistent with a purely in-process cache — whereas the propagation SLA in the ticket is a claim
 * about distributed enforcement. Every rejection assertion below is made against `peerApp`.
 *
 * Requires both TEST_DATABASE_URL and TEST_REDIS_URL. The suite skips without them; see
 * docs/security/device_revocation_and_logout.md for the compose invocation.
 */

const redisUrl = process.env.TEST_REDIS_URL;
const enabled = integrationEnabled && Boolean(redisUrl);
const integrationTest = test.skipIf(!enabled);

/** The ticket's propagation budget. Generous by design — the real number is one Redis round trip. */
const PROPAGATION_SLA_MS = 5_000;

let database: TestDatabase | undefined;
let sql: Sql;
let redis: RedisClient | undefined;
let tenant: TenantFixture;
let otherTenant: TenantFixture;
let app: OpenAPIHono<AppEnv>;
let peerApp: OpenAPIHono<AppEnv>;
let keyStore: KeyStore;

beforeAll(async () => {
  if (!enabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;

  tenant = await createFullTenant(sql);
  // A second, fully independent tenant. The cross-tenant cases need a real school with real users,
  // not a fabricated uuid — a nonexistent id would pass the isolation assertions vacuously.
  otherTenant = await createFullTenant(sql);

  // Discarded rather than captured: this suite asserts on HTTP behaviour and database state, and
  // the log lines it would otherwise collect are never read.
  const logger = createLogger({ destination: () => undefined });
  redis = createRedisClient({ url: redisUrl!, logger });

  keyStore = new KeyStore(60_000);
  await keyStore.init();

  resetSecurityConfig();
  const options = {
    isReady: () => true,
    tracker: createInflightTracker(),
    logger,
    database: sql,
    redis,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
  };

  app = createApp({ ...options, tracker: createInflightTracker() });
  peerApp = createApp({ ...options, tracker: createInflightTracker() });
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  redis?.disconnect();
  await database?.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * An Authorization header for a user, carrying the roles named.
 *
 * Roles are always explicit here, never defaulted. mintTestToken falls back to [ORG_ADMIN] when the
 * caller omits them, which quietly hands every test subject administrative authority — an earlier
 * draft of the 403 case below "passed" a student through an admin route for exactly that reason.
 * Authorization is decided by the roles claim, not by which user id the token names, so a test about
 * permissions has to say which permissions it is testing with.
 */
async function bearer(
  userId: string,
  schoolId: string,
  roles: Role[],
  channel: "web" | "mobile" | "api" = AUTH_CHANNELS.API,
): Promise<string> {
  return `Bearer ${await mintTestToken(keyStore, { userId, schoolId, roles, channel })}`;
}

/** The admin routes gate on `requireChannel(WEB)` — every call against them needs a web-channel token. */
async function adminBearer(userId: string, schoolId: string, roles: Role[]): Promise<string> {
  return bearer(userId, schoolId, roles, AUTH_CHANNELS.WEB);
}

/** Hit a route that exists and requires authentication, to observe whether a token is still accepted. */
async function probeProtected(
  instance: OpenAPIHono<AppEnv>,
  authorization: string,
): Promise<Response> {
  return await instance.request("/api/auth/sessions", { headers: { authorization } });
}

async function isDenylisted(jti: string): Promise<boolean> {
  return (await redis!.exists(jtiDenylistKey(jti))) === 1;
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

describe("POST /api/auth/logout", () => {
  integrationTest("revokes the family and denylists the access token it minted", async () => {
    const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.STUDENT.id, {
      channel: "mobile",
    });

    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ended: true });

    const [row] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM app.refresh_tokens WHERE id = ${seed.sessionId}
    `;
    expect(row!.revoked_at).not.toBeNull();
    expect(await isDenylisted(seed.accessJti!)).toBe(true);
  });

  integrationTest("makes the revoked refresh token fail to rotate", async () => {
    const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.STUDENT.id, {
      channel: "mobile",
    });

    await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });

    const refresh = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });

    expect(refresh.status).toBe(401);
    expect(refresh.headers.get("content-type")).toContain("application/problem+json");
  });

  integrationTest("still answers 200 for a token that never existed", async () => {
    // The no-oracle property. A caller must not be able to tell a live session from a fabricated one
    // by logging out of it.
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        refresh_token: `${tenant.schoolId}.${tenant.users.STUDENT.id}.notarealsecretatall`,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ended: true });
  });

  integrationTest("revokes a pre-000030 session without denylisting anything", async () => {
    // A session seeded with no access_jti, as every row written before migration 000030 has. The
    // Postgres half must still happen; there is simply nothing to deny.
    const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.STUDENT.id, {
      channel: "mobile",
      accessJti: null,
    });

    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });

    expect(res.status).toBe(200);

    const [row] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM app.refresh_tokens WHERE id = ${seed.sessionId}
    `;
    expect(row!.revoked_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

describe("denylist propagation", () => {
  integrationTest(
    "rejects a denylisted access token on a second instance within the SLA",
    async () => {
      const user = tenant.users.STUDENT;
      const jti = crypto.randomUUID();

      const seed = await createRefreshSession(sql, tenant.schoolId, user.id, {
        channel: "mobile",
        accessJti: jti,
      });

      // The access token carries the same jti the session row records, which is the invariant
      // issueTokenPair maintains in production.
      const accessToken = await mintTestToken(keyStore, {
        userId: user.id,
        schoolId: tenant.schoolId,
        jti,
      });
      const authorization = `Bearer ${accessToken}`;

      // Live on both instances before the revocation.
      expect((await probeProtected(app, authorization)).status).toBe(200);
      expect((await probeProtected(peerApp, authorization)).status).toBe(200);

      const startedAt = Date.now();
      await app.request("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: seed.token }),
      });

      // The peer instance never saw the logout. It learns about it only through Redis.
      const rejected = await probeProtected(peerApp, authorization);
      const elapsedMs = Date.now() - startedAt;

      expect(rejected.status).toBe(401);
      expect(elapsedMs).toBeLessThan(PROPAGATION_SLA_MS);
    },
  );

  integrationTest(
    "gives each denylist entry a TTL bounded by the token's own lifetime",
    async () => {
      const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.STUDENT.id, {
        channel: "mobile",
      });

      await app.request("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: seed.token }),
      });

      // Self-pruning is what keeps the keyspace bounded by the access-token TTL rather than by logout
      // volume. A missing or infinite TTL (-1) would be a slow memory leak that nothing else detects.
      const ttl = await redis!.ttl(jtiDenylistKey(seed.accessJti!));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    },
  );

  integrationTest("writes nothing for an already-expired access token", async () => {
    const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.STUDENT.id, {
      channel: "mobile",
      accessExpiresAt: new Date(Date.now() - 60_000),
    });

    await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });

    // Verification already rejects this token on `exp`. An entry would be pure waste, and Redis
    // rejects a non-positive EX outright.
    expect(await isDenylisted(seed.accessJti!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Device routes
// ---------------------------------------------------------------------------

describe("device revocation", () => {
  integrationTest("DELETE /api/auth/devices/{id} kills every session on that device", async () => {
    const user = tenant.users.INSTRUCTOR;
    const device = await createUserDevice(sql, tenant.schoolId, user.id);

    const onDevice = await Promise.all([
      createRefreshSession(sql, tenant.schoolId, user.id, { deviceId: device.id }),
      createRefreshSession(sql, tenant.schoolId, user.id, { deviceId: device.id }),
    ]);
    const elsewhere = await createRefreshSession(sql, tenant.schoolId, user.id);

    const res = await app.request(`/api/auth/devices/${device.id}`, {
      method: "DELETE",
      headers: { authorization: await bearer(user.id, tenant.schoolId, [ROLES.INSTRUCTOR]) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: number; denylisted: number };
    expect(body.revoked).toBe(2);
    expect(body.denylisted).toBe(2);

    for (const seed of onDevice) {
      expect(await isDenylisted(seed.accessJti!)).toBe(true);
    }

    // The session on another device is untouched. Revocation is scoped, not a blunt instrument.
    const [survivor] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM app.refresh_tokens WHERE id = ${elsewhere.sessionId}
    `;
    expect(survivor!.revoked_at).toBeNull();

    // And the device itself is deregistered, so it stops receiving push.
    const [deviceRow] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM app.user_devices WHERE id = ${device.id}
    `;
    expect(deviceRow!.revoked_at).not.toBeNull();
  });

  integrationTest(
    "GET /api/auth/devices lists the caller's devices with session counts",
    async () => {
      const user = tenant.users.TEACHING_ASSISTANT;
      const device = await createUserDevice(sql, tenant.schoolId, user.id);
      await createRefreshSession(sql, tenant.schoolId, user.id, { deviceId: device.id });

      const res = await app.request("/api/auth/devices", {
        headers: { authorization: await bearer(user.id, tenant.schoolId, [ROLES.INSTRUCTOR]) },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        devices: { id: string; active_session_count: number }[];
      };

      const listed = body.devices.find((entry) => entry.id === device.id);
      expect(listed).toBeDefined();
      expect(listed!.active_session_count).toBe(1);
      // The push credential must never reach a client.
      expect(JSON.stringify(body)).not.toContain("fcm");
    },
  );

  integrationTest("answers 200 with zero for another user's device", async () => {
    const victim = tenant.users.INSTRUCTOR;
    const device = await createUserDevice(sql, tenant.schoolId, victim.id);
    const seed = await createRefreshSession(sql, tenant.schoolId, victim.id, {
      deviceId: device.id,
    });

    const res = await app.request(`/api/auth/devices/${device.id}`, {
      method: "DELETE",
      headers: {
        authorization: await bearer(tenant.users.STUDENT.id, tenant.schoolId, [ROLES.STUDENT]),
      },
    });

    // Not a 403 and not a 404. Both would confirm the id names something real, which is exactly
    // what a caller enumerating device ids wants to learn.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 0, denylisted: 0 });

    const [row] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM app.refresh_tokens WHERE id = ${seed.sessionId}
    `;
    expect(row!.revoked_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Administrative revocation
// ---------------------------------------------------------------------------

describe("admin device revocation", () => {
  integrationTest("revoke-all terminates every family the target holds", async () => {
    const target = tenant.users.STUDENT;
    const deviceA = await createUserDevice(sql, tenant.schoolId, target.id, {
      fcmToken: `tok-${crypto.randomUUID()}`,
    });

    const seeds = await Promise.all([
      createRefreshSession(sql, tenant.schoolId, target.id, { deviceId: deviceA.id }),
      createRefreshSession(sql, tenant.schoolId, target.id),
      createRefreshSession(sql, tenant.schoolId, target.id, { channel: "mobile" }),
    ]);

    const res = await app.request(`/api/admin/users/${target.id}/devices`, {
      method: "DELETE",
      headers: {
        authorization: await adminBearer(tenant.users.ORG_ADMIN.id, tenant.schoolId, [
          ROLES.ORG_ADMIN,
        ]),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: number; denylisted: number };
    expect(body.revoked).toBeGreaterThanOrEqual(seeds.length);

    const live = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM app.refresh_tokens
       WHERE user_id = ${target.id} AND revoked_at IS NULL
    `;
    expect(Number(live[0]!.count)).toBe(0);

    for (const seed of seeds) {
      expect(await isDenylisted(seed.accessJti!)).toBe(true);
    }
  });

  integrationTest("files the audit row against the administrator, not the victim", async () => {
    const target = tenant.users.INSTRUCTOR;
    const admin = tenant.users.ORG_ADMIN;
    await createRefreshSession(sql, tenant.schoolId, target.id);

    await app.request(`/api/admin/users/${target.id}/devices`, {
      method: "DELETE",
      headers: { authorization: await adminBearer(admin.id, tenant.schoolId, [ROLES.ORG_ADMIN]) },
    });

    const [entry] = await sql<{ actor_id: string; new_values: Record<string, unknown> }[]>`
      SELECT actor_id, new_values FROM app.audit_logs
       WHERE target_table = 'refresh_tokens'
         AND new_values ->> 'reason' = 'admin_revoke_all_devices'
         AND new_values ->> 'target_user_id' = ${target.id}
       ORDER BY created_at DESC
       LIMIT 1
    `;

    expect(entry).toBeDefined();
    // The whole point of routing this through a SECURITY DEFINER function rather than opening the
    // transaction as the target: the actor must be the admin who acted.
    expect(entry!.actor_id).toBe(admin.id);
    expect(entry!.new_values["target_user_id"]).toBe(target.id);
  });

  integrationTest("refuses a caller without USER_SUSPEND", async () => {
    const res = await app.request(`/api/admin/users/${tenant.users.INSTRUCTOR.id}/devices`, {
      method: "DELETE",
      headers: {
        authorization: await adminBearer(tenant.users.STUDENT.id, tenant.schoolId, [ROLES.STUDENT]),
      },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as { code: string; request_id: string; status: number };
    expect(problem.code).toBe("AUTHZ_FORBIDDEN");
    expect(problem.status).toBe(403);
    expect(problem.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  integrationTest("cannot reach a user in another tenant", async () => {
    const foreignUser = otherTenant.users.STUDENT;
    const seed = await createRefreshSession(sql, otherTenant.schoolId, foreignUser.id);

    const res = await app.request(`/api/admin/users/${foreignUser.id}/devices`, {
      method: "DELETE",
      headers: {
        authorization: await adminBearer(tenant.users.ORG_ADMIN.id, tenant.schoolId, [
          ROLES.ORG_ADMIN,
        ]),
      },
    });

    // Indistinguishable from a nonexistent user, by design — see the header of
    // routes/admin-device-routes.ts.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 0, denylisted: 0 });

    // And the foreign session is genuinely untouched, which is the assertion that actually matters.
    const [row] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM app.refresh_tokens WHERE id = ${seed.sessionId}
    `;
    expect(row!.revoked_at).toBeNull();
    expect(await isDenylisted(seed.accessJti!)).toBe(false);
  });

  integrationTest("narrows to one device when a device id is given", async () => {
    const target = tenant.users.TEACHING_ASSISTANT;
    const device = await createUserDevice(sql, tenant.schoolId, target.id, {
      fcmToken: `tok-${crypto.randomUUID()}`,
    });

    const onDevice = await createRefreshSession(sql, tenant.schoolId, target.id, {
      deviceId: device.id,
    });
    const elsewhere = await createRefreshSession(sql, tenant.schoolId, target.id);

    const res = await app.request(`/api/admin/users/${target.id}/devices/${device.id}`, {
      method: "DELETE",
      headers: {
        authorization: await adminBearer(tenant.users.ORG_ADMIN.id, tenant.schoolId, [
          ROLES.ORG_ADMIN,
        ]),
      },
    });

    expect(res.status).toBe(200);

    const [killed] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM app.refresh_tokens WHERE id = ${onDevice.sessionId}
    `;
    const [survivor] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM app.refresh_tokens WHERE id = ${elsewhere.sessionId}
    `;

    expect(killed!.revoked_at).not.toBeNull();
    expect(survivor!.revoked_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Administrative session/device listing (ST-187)
// ---------------------------------------------------------------------------

describe("admin session/device listing", () => {
  integrationTest("GET .../sessions lists another user's live sessions", async () => {
    const target = tenant.users.STUDENT;
    const admin = tenant.users.ORG_ADMIN;
    const seed = await createRefreshSession(sql, tenant.schoolId, target.id, { channel: "mobile" });

    const res = await app.request(`/api/admin/users/${target.id}/sessions`, {
      headers: { authorization: await adminBearer(admin.id, tenant.schoolId, [ROLES.ORG_ADMIN]) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { id: string; channel: string }[] };
    const listed = body.sessions.find((entry) => entry.id === seed.sessionId);
    expect(listed).toBeDefined();
    expect(listed!.channel).toBe("mobile");
    // token_hash is a credential and must never reach a client.
    expect(JSON.stringify(body)).not.toContain("token_hash");
  });

  integrationTest("GET .../devices lists another user's devices with session counts", async () => {
    const target = tenant.users.INSTRUCTOR;
    const admin = tenant.users.ORG_ADMIN;
    const device = await createUserDevice(sql, tenant.schoolId, target.id, {
      fcmToken: `tok-${crypto.randomUUID()}`,
    });
    await createRefreshSession(sql, tenant.schoolId, target.id, { deviceId: device.id });

    const res = await app.request(`/api/admin/users/${target.id}/devices`, {
      headers: { authorization: await adminBearer(admin.id, tenant.schoolId, [ROLES.ORG_ADMIN]) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      devices: { id: string; active_session_count: number }[];
    };
    const listed = body.devices.find((entry) => entry.id === device.id);
    expect(listed).toBeDefined();
    expect(listed!.active_session_count).toBe(1);
    // The push credential must never reach a client.
    expect(JSON.stringify(body)).not.toContain("tok-");
  });

  integrationTest("refuses a caller without USER_SUSPEND", async () => {
    const res = await app.request(`/api/admin/users/${tenant.users.INSTRUCTOR.id}/sessions`, {
      headers: {
        authorization: await adminBearer(tenant.users.STUDENT.id, tenant.schoolId, [ROLES.STUDENT]),
      },
    });

    expect(res.status).toBe(403);
    const problem = (await res.json()) as { code: string };
    expect(problem.code).toBe("AUTHZ_FORBIDDEN");
  });

  integrationTest("cannot list sessions for a user in another tenant", async () => {
    const foreignUser = otherTenant.users.STUDENT;
    await createRefreshSession(sql, otherTenant.schoolId, foreignUser.id);

    const res = await app.request(`/api/admin/users/${foreignUser.id}/sessions`, {
      headers: {
        authorization: await adminBearer(tenant.users.ORG_ADMIN.id, tenant.schoolId, [
          ROLES.ORG_ADMIN,
        ]),
      },
    });

    // Indistinguishable from a nonexistent user, matching the revoke routes' own convention.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });

  integrationTest("cannot list devices for a user in another tenant", async () => {
    const foreignUser = otherTenant.users.INSTRUCTOR;
    await createUserDevice(sql, otherTenant.schoolId, foreignUser.id, {
      fcmToken: `tok-${crypto.randomUUID()}`,
    });

    const res = await app.request(`/api/admin/users/${foreignUser.id}/devices`, {
      headers: {
        authorization: await adminBearer(tenant.users.ORG_ADMIN.id, tenant.schoolId, [
          ROLES.ORG_ADMIN,
        ]),
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ devices: [] });
  });
});
