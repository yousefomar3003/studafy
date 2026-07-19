// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createFullTenant,
  createRefreshSession,
  createTestDatabase,
  createUserDevice,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantFixture, TestDatabase } from "../harness";
import type { Sql } from "postgres";

/**
 * ST-071 — refresh-token rotation, reuse detection, and family revocation.
 *
 * These go through the real service against a real database rather than through HTTP, and that is a
 * deliberate trade. The properties under test here are transactional — did the parent get consumed
 * in the same transaction that inserted the child, did the audit row commit with the revocation, did
 * the loser of a race roll its child back — and a status code cannot distinguish "rotated correctly"
 * from "rotated and left the family in a half-updated state". The routes get their own coverage in
 * session-http.test.ts, which is where the HTTP-shaped questions live.
 *
 * Every test builds its own tenant. Sharing one would make the reuse tests order-dependent, since
 * the first one to detect a breach revokes a family the next would want intact.
 */

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | undefined;
let sql: Sql;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;
  tenant = await createFullTenant(sql);
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a service config around a throwaway key store.
 *
 * Imported lazily inside the helper rather than at module scope because these modules reach
 * src/openapi/components.ts transitively, which decorates shared schemas with `.openapi()` and
 * throws at module-init if @hono/zod-openapi has not been loaded first. A file that never builds an
 * app has no other reason to load it. tests/auth/support.ts documents the same hazard.
 */
async function sessionConfig(): Promise<{
  config: import("../../src/modules/auth").SessionTokenConfig;
  destroy: () => void;
}> {
  const { KeyStore } = await import("../../src/modules/auth/jwt/key-store");
  const keyStore = new KeyStore(60_000);
  await keyStore.init();

  return {
    config: {
      keyStore,
      issuer: "studafy-test",
      audience: "studafy-api-test",
      accessTtlSeconds: 900,
      refreshTtlSeconds: 30 * 24 * 60 * 60,
    },
    destroy: () => keyStore.destroy(),
  };
}

/** Read a token row's lifecycle columns, bypassing RLS so the assertion sees the true state. */
async function readToken(sessionId: string): Promise<{
  rotated_at: Date | null;
  revoked_at: Date | null;
  replaced_by_token_id: string | null;
  family_id: string;
  parent_token_id: string | null;
  channel: string;
  device_id: string | null;
}> {
  const [row] = await sql<
    {
      rotated_at: Date | null;
      revoked_at: Date | null;
      replaced_by_token_id: string | null;
      family_id: string;
      parent_token_id: string | null;
      channel: string;
      device_id: string | null;
    }[]
  >`
    SELECT rotated_at, revoked_at, replaced_by_token_id, family_id, parent_token_id, channel, device_id
      FROM app.refresh_tokens WHERE id = ${sessionId}
  `;
  return row!;
}

async function familyRows(
  familyId: string,
): Promise<{ id: string; revoked_at: Date | null; rotated_at: Date | null }[]> {
  return sql<{ id: string; revoked_at: Date | null; rotated_at: Date | null }[]>`
    SELECT id, revoked_at, rotated_at FROM app.refresh_tokens
     WHERE family_id = ${familyId} ORDER BY issued_at
  `;
}

// ---------------------------------------------------------------------------
// Normal rotation
// ---------------------------------------------------------------------------

describe("normal rotation", () => {
  integrationTest("consumes the presented token and issues a working child", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const { config, destroy } = await sessionConfig();

    try {
      const user = tenant.users.INSTRUCTOR;
      const seed = await createRefreshSession(sql, tenant.schoolId, user.id, { channel: "mobile" });

      const rotated = await rotateRefreshToken(sql, config, { presentedToken: seed.token });

      // The parent is consumed, and points at what replaced it.
      const parent = await readToken(seed.sessionId);
      expect(parent.rotated_at).not.toBeNull();
      expect(parent.replaced_by_token_id).toBe(rotated.sessionId);
      expect(parent.revoked_at).toBeNull();

      // The child continues the same family and names its parent.
      const child = await readToken(rotated.sessionId);
      expect(child.family_id).toBe(seed.familyId);
      expect(child.parent_token_id).toBe(seed.sessionId);
      expect(child.rotated_at).toBeNull();

      // Channel rides along unchanged — this is what decides cookie-vs-body delivery later.
      expect(child.channel).toBe("mobile");

      // And the child is a working credential: rotating it again succeeds.
      const grandchild = await rotateRefreshToken(sql, config, {
        presentedToken: rotated.refreshToken,
      });
      expect(grandchild.sessionId).not.toBe(rotated.sessionId);
      expect((await readToken(rotated.sessionId)).rotated_at).not.toBeNull();
    } finally {
      destroy();
    }
  });

  integrationTest(
    "carries device identity forward but refreshes observational fields",
    async () => {
      const { rotateRefreshToken } = await import("../../src/modules/auth");
      const { config, destroy } = await sessionConfig();

      try {
        const user = tenant.users.STUDENT;
        const device = await createUserDevice(sql, tenant.schoolId, user.id, { platform: "ios" });
        const seed = await createRefreshSession(sql, tenant.schoolId, user.id, {
          channel: "mobile",
          deviceId: device.id,
          userAgent: "old-agent/1.0",
        });

        const rotated = await rotateRefreshToken(sql, config, {
          presentedToken: seed.token,
          device: { userAgent: "new-agent/2.0", ipAddress: "203.0.113.9" },
        });

        const child = await readToken(rotated.sessionId);
        // The device the session belongs to is not something a request may change.
        expect(child.device_id).toBe(device.id);

        const [observed] = await sql<{ user_agent: string; ip_address: string }[]>`
        SELECT user_agent, host(ip_address) AS ip_address
          FROM app.refresh_tokens WHERE id = ${rotated.sessionId}
      `;
        expect(observed!.user_agent).toBe("new-agent/2.0");
        // host() strips the prefix length: an inet column renders as "203.0.113.9/32" otherwise.
        expect(observed!.ip_address).toBe("203.0.113.9");
      } finally {
        destroy();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Reuse detection
// ---------------------------------------------------------------------------

describe("reuse detection", () => {
  integrationTest("revokes the entire family when a consumed token is replayed", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const { config, destroy } = await sessionConfig();

    try {
      const user = tenant.users.TEACHING_ASSISTANT;
      const seed = await createRefreshSession(sql, tenant.schoolId, user.id);

      // Build a chain three deep, so "the whole family" is a meaningful claim.
      const first = await rotateRefreshToken(sql, config, { presentedToken: seed.token });
      const second = await rotateRefreshToken(sql, config, {
        presentedToken: first.refreshToken,
      });

      const before = await familyRows(seed.familyId);
      expect(before).toHaveLength(3);
      expect(before.every((row) => row.revoked_at === null)).toBe(true);

      // Replay the original — the token an attacker would have captured first.
      await expect(
        rotateRefreshToken(sql, config, { presentedToken: seed.token }),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });

      const after = await familyRows(seed.familyId);
      expect(after).toHaveLength(3);
      expect(after.every((row) => row.revoked_at !== null)).toBe(true);

      // Including the live tip: the legitimate holder is logged out too, which is the point.
      await expect(
        rotateRefreshToken(sql, config, { presentedToken: second.refreshToken }),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    } finally {
      destroy();
    }
  });

  integrationTest("writes a critical audit row naming the family", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const { config, destroy } = await sessionConfig();

    try {
      const user = tenant.users.ORG_ADMIN;
      const seed = await createRefreshSession(sql, tenant.schoolId, user.id);
      await rotateRefreshToken(sql, config, { presentedToken: seed.token });

      const requestId = crypto.randomUUID();
      await expect(
        rotateRefreshToken(sql, config, { presentedToken: seed.token, requestId }),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });

      const [audit] = await sql<
        {
          action: string;
          target_table: string;
          target_id: string;
          actor_id: string;
          request_id: string;
          new_values: Record<string, unknown>;
        }[]
      >`
        SELECT action, target_table, target_id, actor_id, request_id, new_values
          FROM app.audit_logs
         WHERE target_id = ${seed.familyId} AND request_id = ${requestId}
      `;

      expect(audit).toBeDefined();
      expect(audit!.action).toBe("logout");
      expect(audit!.target_table).toBe("refresh_tokens");
      // Identity columns come from the transaction GUCs, never from application arguments.
      expect(audit!.actor_id).toBe(user.id);
      expect(audit!.new_values.reason).toBe("refresh_token_reuse_detected");
      expect(audit!.new_values.revoked_token_count).toBe(2);
    } finally {
      destroy();
    }
  });

  integrationTest("revokes the device the compromised session was bound to", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const { config, destroy } = await sessionConfig();

    try {
      const user = tenant.users.INSTRUCTOR;
      const device = await createUserDevice(sql, tenant.schoolId, user.id, { platform: "android" });
      const seed = await createRefreshSession(sql, tenant.schoolId, user.id, {
        deviceId: device.id,
      });

      await rotateRefreshToken(sql, config, { presentedToken: seed.token });
      await expect(
        rotateRefreshToken(sql, config, { presentedToken: seed.token }),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });

      const [row] = await sql<{ revoked_at: Date | null }[]>`
        SELECT revoked_at FROM app.user_devices WHERE id = ${device.id}
      `;
      // A stolen handset keeps receiving push notifications otherwise.
      expect(row!.revoked_at).not.toBeNull();
    } finally {
      destroy();
    }
  });

  integrationTest("treats an already-revoked token as reuse, not as expiry", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const { config, destroy } = await sessionConfig();

    try {
      const user = tenant.users.STUDENT;
      const seed = await createRefreshSession(sql, tenant.schoolId, user.id, {
        revokedAt: new Date(),
      });

      await expect(
        rotateRefreshToken(sql, config, { presentedToken: seed.token }),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    } finally {
      destroy();
    }
  });

  integrationTest(
    "checks reuse before expiry, so an aged replay still trips the alarm",
    async () => {
      const { rotateRefreshToken } = await import("../../src/modules/auth");
      const { config, destroy } = await sessionConfig();

      try {
        const user = tenant.users.GUEST;
        // Consumed *and* long expired — an attacker who sat on a stolen token past its lifetime.
        const seed = await createRefreshSession(sql, tenant.schoolId, user.id, {
          rotatedAt: new Date(Date.now() - 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 30 * 60 * 1000),
        });

        await expect(
          rotateRefreshToken(sql, config, { presentedToken: seed.token }),
        ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });

        // Reporting this as merely expired would let the replay pass unnoticed.
        const rows = await familyRows(seed.familyId);
        expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
      } finally {
        destroy();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Rejection taxonomy
// ---------------------------------------------------------------------------

describe("rejections", () => {
  integrationTest("reports an expired token as expired", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const { config, destroy } = await sessionConfig();

    try {
      const user = tenant.users.STUDENT;
      const seed = await createRefreshSession(sql, tenant.schoolId, user.id, {
        expiresAt: new Date(Date.now() - 1000),
      });

      // The distinct code matters: a client seeing AUTH_TOKEN_EXPIRED re-authenticates, while one
      // seeing AUTH_TOKEN_INVALID on the same condition would retry into a loop.
      await expect(
        rotateRefreshToken(sql, config, { presentedToken: seed.token }),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_EXPIRED" });
    } finally {
      destroy();
    }
  });

  integrationTest("rejects a correct locator carrying the wrong secret", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const { config, destroy } = await sessionConfig();

    try {
      const user = tenant.users.INSTRUCTOR;
      const seed = await createRefreshSession(sql, tenant.schoolId, user.id);
      const other = await createRefreshSession(sql, tenant.schoolId, user.id);

      // Correct tenant and user, secret from a different session. The ids scope the search; only the
      // secret proves anything, so this must find nothing.
      const forged = `${tenant.schoolId}.${user.id}.${other.token.split(".")[2]}`;

      await expect(
        rotateRefreshToken(sql, config, { presentedToken: forged }),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });

      // And the real token still works: a failed guess must not consume the session.
      const rotated = await rotateRefreshToken(sql, config, { presentedToken: seed.token });
      expect(rotated.sessionId).toBeDefined();
    } finally {
      destroy();
    }
  });

  integrationTest("rejects malformed and unresolvable tokens alike", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const { config, destroy } = await sessionConfig();

    try {
      // A caller probing the endpoint learns nothing from the difference between these two: both
      // answer 401, and neither reveals whether the locator format was even close.
      for (const presented of [
        "not-a-token",
        "",
        `${tenant.schoolId}.${tenant.users.STUDENT.id}.Xk7pQ2abc`,
      ]) {
        await expect(
          rotateRefreshToken(sql, config, { presentedToken: presented }),
        ).rejects.toThrow();
      }
    } finally {
      destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrent rotation", () => {
  integrationTest("lets exactly one of two simultaneous refreshes win", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const { config, destroy } = await sessionConfig();

    try {
      const user = tenant.users.SUPPORT_AGENT;
      const seed = await createRefreshSession(sql, tenant.schoolId, user.id);

      const results = await Promise.allSettled([
        rotateRefreshToken(sql, config, { presentedToken: seed.token }),
        rotateRefreshToken(sql, config, { presentedToken: seed.token }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Without the `AND rotated_at IS NULL` guard on the consuming UPDATE, both would succeed and
      // the family would fork into two live branches that each look legitimate.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The loser rolled its child back rather than leaving an orphan.
      const rows = await familyRows(seed.familyId);
      expect(rows).toHaveLength(2);
    } finally {
      destroy();
    }
  });
});
