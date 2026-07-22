/**
 * Channel guard integration tests.
 *
 * Verifies that all administrative mutation routes reject mobile and API channel
 * tokens with CHANNEL_NOT_AUTHORIZED (403), regardless of the caller's role. Web
 * channel tokens pass through to the permission guard.
 *
 * acceptance criteria:
 * - Admin role via mobile token cannot mutate (all admin routes)
 * - Admin role via api token cannot mutate (all admin routes)
 * - Web channel unaffected
 * - Denials audited (structured log line with event, channel, route)
 */

// Imported before src/middleware — see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { apiProblemSchema } from "../../src/middleware";
import { KeyStore } from "../../src/modules/auth";
import {
  createFullTenant,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";

import type { AppEnv } from "../../src/middleware";
import type { AuthChannel } from "../../src/modules/auth/channels";
import type { TenantFixture, TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | undefined;
let sql: Sql;
let tenant: TenantFixture;
let app: OpenAPIHono<AppEnv>;
let keyStore: KeyStore;

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;
  tenant = await createFullTenant(sql);

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
  });
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

/** Mint a token for the ORG_ADMIN user on the given channel. */
async function adminToken(channel: AuthChannel): Promise<string> {
  return mintTestToken(keyStore, {
    schoolId: tenant.schoolId,
    userId: tenant.users.ORG_ADMIN.id,
    roles: ["ORG_ADMIN"],
    channel,
  });
}

/** Assert a response is a well-formed RFC 9457 problem document with CHANNEL_NOT_AUTHORIZED. */
async function expectChannelDenied(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(res.headers.get("content-type")).toBe("application/problem+json");

  const body: unknown = await res.json();
  const parsed = apiProblemSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  expect(parsed.data?.code).toBe("CHANNEL_NOT_AUTHORIZED");
  expect(parsed.data?.status).toBe(403);
}

// ---------------------------------------------------------------------------
// Admin device routes
// ---------------------------------------------------------------------------

describe("admin device routes — channel guard", () => {
  const userId = () => tenant.users.STUDENT.id;
  const fakeDeviceId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  integrationTest("mobile token is rejected on DELETE all devices", async () => {
    const token = await adminToken("mobile");
    const res = await app.request(`/api/admin/users/${userId()}/devices`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectChannelDenied(res);
  });

  integrationTest("api token is rejected on DELETE all devices", async () => {
    const token = await adminToken("api");
    const res = await app.request(`/api/admin/users/${userId()}/devices`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectChannelDenied(res);
  });

  integrationTest("web token passes channel guard on DELETE all devices", async () => {
    const token = await adminToken("web");
    const res = await app.request(`/api/admin/users/${userId()}/devices`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    // 200 with zero revoked (no sessions to revoke), not 403 from channel guard.
    expect(res.status).toBe(200);
  });

  integrationTest("mobile token is rejected on DELETE one device", async () => {
    const token = await adminToken("mobile");
    const res = await app.request(`/api/admin/users/${userId()}/devices/${fakeDeviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectChannelDenied(res);
  });

  integrationTest("api token is rejected on DELETE one device", async () => {
    const token = await adminToken("api");
    const res = await app.request(`/api/admin/users/${userId()}/devices/${fakeDeviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectChannelDenied(res);
  });

  integrationTest("web token passes channel guard on DELETE one device", async () => {
    const token = await adminToken("web");
    const res = await app.request(`/api/admin/users/${userId()}/devices/${fakeDeviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    // 200 with zero revoked (device doesn't exist in this tenant), not 403 from channel guard.
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Admin provider unlink route
// ---------------------------------------------------------------------------

describe("admin provider unlink — channel guard", () => {
  const userId = () => tenant.users.STUDENT.id;

  integrationTest("mobile token is rejected on admin provider unlink", async () => {
    const token = await adminToken("mobile");
    const res = await app.request(`/api/admin/users/${userId()}/providers/google`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectChannelDenied(res);
  });

  integrationTest("api token is rejected on admin provider unlink", async () => {
    const token = await adminToken("api");
    const res = await app.request(`/api/admin/users/${userId()}/providers/google`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectChannelDenied(res);
  });

  integrationTest("web token passes channel guard on admin provider unlink", async () => {
    const token = await adminToken("web");
    const res = await app.request(`/api/admin/users/${userId()}/providers/google`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    // 404 (no such provider linked), not 403 from channel guard.
    expect(res.status).not.toBe(403);
  });
});
