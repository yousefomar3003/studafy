// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { hashInvitationToken, KeyStore } from "../../src/modules/auth";
import {
  createSchool,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";

import type { CapturedLine } from "./support";
import type { SecurityEvent, SecurityEventSink } from "../../src/lib/security/securityEventSink";
import type { AppEnv } from "../../src/middleware";
import type { RedisClient } from "../../src/redis";
import type { TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const VERIFY_PREFIX = "/api/auth/invitations";

let database: TestDatabase | undefined;
let sql: Sql;
let app: OpenAPIHono<AppEnv>;
let keyStore: KeyStore;
let lines: CapturedLine[];
let securityEvents: SecurityEvent[];
let activeSchool: { id: string; name: string };

interface InvitationSeedOptions {
  token?: string;
  email?: string;
  createdAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date | null;
  consumedAt?: Date | null;
}

async function setSchoolStatus(
  schoolId: string,
  status: "pending" | "active" | "suspended" | "archived",
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`UPDATE app.schools SET status = ${status}::app.school_status WHERE id = ${schoolId}`;
  });
}

async function seedInvitation(
  schoolId: string,
  options: InvitationSeedOptions = {},
): Promise<string> {
  const token = options.token ?? crypto.getRandomValues(new Uint8Array(32)).toHex();
  const email = options.email ?? `invite-${crypto.randomUUID()}@example.test`;
  const createdAt = options.createdAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);

  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.invitations (
        school_id, email, normalized_email, role, token_hash, expires_at,
        revoked_at, consumed_at, created_at
      ) VALUES (
        ${schoolId},
        ${email},
        ${email.toLowerCase().trim()},
        'STUDENT'::app.user_role,
        ${hashInvitationToken(token)}::bytea,
        ${expiresAt},
        ${options.revokedAt ?? null},
        ${options.consumedAt ?? null},
        ${createdAt}
      )
    `;
  });

  return token;
}

function verify(token: string, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.request(`${VERIFY_PREFIX}/${token}/verify`, {
      method: "GET",
      headers,
    }),
  );
}

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;

  const school = await createSchool(sql, { name: "Verification Academy" });
  activeSchool = { id: school.id, name: "Verification Academy" };
  await setSchoolStatus(school.id, "active");

  lines = [];
  securityEvents = [];
  const logger = createLogger({
    destination: (line: string) => lines.push(JSON.parse(line) as CapturedLine),
  });

  keyStore = new KeyStore(60_000);
  await keyStore.init();
  resetSecurityConfig();
  const securityEventSink: SecurityEventSink = {
    record: (event) => securityEvents.push(event),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
    droppedCount: () => 0,
  };
  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger,
    database: sql,
    keyStore,
    securityEventSink,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
  });
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

describe("GET invitation verification", () => {
  integrationTest("is public and returns only the approved valid projection", async () => {
    const token = await seedInvitation(activeSchool.id, { email: "John.Doe@Example.COM" });
    const response = await verify(token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "valid",
      emailHint: "j***e@example.com",
      schoolName: activeSchool.name,
    });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  integrationTest("returns EXPIRED before later lifecycle failures", async () => {
    const createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const token = await seedInvitation(activeSchool.id, {
      createdAt,
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      revokedAt: new Date(createdAt.getTime() + 1000),
    });

    const response = await verify(token);
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({
      code: "EXPIRED",
      detail: "Invitation cannot be used.",
      request_id: response.headers.get("x-request-id"),
    });
  });

  integrationTest("returns REVOKED for an unexpired revoked invitation", async () => {
    const token = await seedInvitation(activeSchool.id, { revokedAt: new Date() });
    const response = await verify(token);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "REVOKED" });
  });

  integrationTest("returns CONSUMED for an already-redeemed invitation", async () => {
    const token = await seedInvitation(activeSchool.id, { consumedAt: new Date() });
    const response = await verify(token);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CONSUMED" });
  });

  for (const status of ["pending", "suspended", "archived"] as const) {
    integrationTest(`returns SCHOOL_SUSPENDED for a ${status} school`, async () => {
      const school = await createSchool(sql, { name: `${status} school` });
      await setSchoolStatus(school.id, status);
      const token = await seedInvitation(school.id);

      const response = await verify(token);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "SCHOOL_SUSPENDED",
        detail: "Invitation cannot be used.",
      });
    });
  }

  integrationTest("makes malformed and nonexistent tokens the same generic problem", async () => {
    const malformed = await verify("not-a-token");
    const nonexistent = await verify("f".repeat(64));

    expect(malformed.status).toBe(400);
    expect(nonexistent.status).toBe(400);
    expect(malformed.headers.get("content-type")).toBe("application/problem+json");
    expect(nonexistent.headers.get("content-type")).toBe("application/problem+json");

    for (const response of [malformed, nonexistent]) {
      expect(await response.json()).toMatchObject({
        code: "INVITATION_INVALID",
        detail: "Invitation is invalid.",
        request_id: response.headers.get("x-request-id"),
      });
    }
  });

  integrationTest(
    "limits the RLS seam to one fixed projection for the supplied digest",
    async () => {
      const otherSchool = await createSchool(sql, { name: "Other School" });
      await setSchoolStatus(otherSchool.id, "active");
      const token = await seedInvitation(otherSchool.id, { email: "other@example.test" });

      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_app");
        await tx`SELECT set_config('app.school_id', ${activeSchool.id}, true)`;
        await tx`SELECT set_config('app.invitation_token_hash', ${hashInvitationToken(token).toString("hex")}, true)`;
        const ordinaryRows =
          await tx`SELECT id FROM app.invitations WHERE token_hash = ${hashInvitationToken(token)}::bytea`;
        expect(ordinaryRows).toHaveLength(0);

        const lookupRows = await tx<{ payload: Record<string, unknown> }[]>`
        SELECT to_jsonb(candidate) AS payload
        FROM app.lookup_invitation_for_verification(${hashInvitationToken(token)}::bytea) AS candidate
      `;
        expect(lookupRows).toHaveLength(1);
        expect(Object.keys(lookupRows[0]!.payload).sort()).toEqual([
          "candidate_hash",
          "consumed_at",
          "expires_at",
          "found",
          "normalized_email",
          "revoked_at",
          "school_name",
          "school_status",
        ]);
        expect(lookupRows[0]!.payload).toMatchObject({
          found: true,
          normalized_email: "other@example.test",
          school_name: "Other School",
        });

        const missingRows = await tx<{ found: boolean }[]>`
        SELECT found
        FROM app.lookup_invitation_for_verification(${hashInvitationToken("c".repeat(64))}::bytea)
      `;
        expect(missingRows).toHaveLength(1);
        expect(missingRows[0]!.found).toBe(false);
      });
    },
  );

  integrationTest(
    "redacts valid, malformed, failing, and unmatched URLs from logs and security events",
    async () => {
      const validToken = await seedInvitation(activeSchool.id);
      const malformedToken = `malformed-${crypto.randomUUID()}`;
      const failingToken = await seedInvitation(activeSchool.id, {
        expiresAt: new Date(Date.now() - 60_000),
      });
      const unmatchedToken = crypto.getRandomValues(new Uint8Array(32)).toHex();
      const rawTokens = [validToken, malformedToken, failingToken, unmatchedToken];
      const before = lines.length;
      const eventsBefore = securityEvents.length;
      const rejectedOrigin = { Origin: "https://untrusted.example" };

      await verify(validToken, rejectedOrigin);
      await verify(malformedToken, rejectedOrigin);
      await verify(failingToken, rejectedOrigin);

      const unmatched = await app.request(`${VERIFY_PREFIX}/${unmatchedToken}/verify/unmatched`, {
        headers: rejectedOrigin,
      });
      const unmatchedBody = await unmatched.text();
      const emitted = JSON.stringify(lines.slice(before));
      const recordedEvents = JSON.stringify(securityEvents.slice(eventsBefore));

      for (const token of rawTokens) {
        expect(emitted).not.toContain(token);
        expect(recordedEvents).not.toContain(token);
        expect(unmatchedBody).not.toContain(token);
      }

      expect(emitted).toContain("[REDACTED]");
      expect(recordedEvents).toContain("[REDACTED]");

      // The unmatched arm answers 401, not a redacted 404: only the exact six-segment shape is public,
      // so jwtAuth short-circuits a descendant path before the not-found handler ever renders one. That
      // is the stricter outcome — the body carries no path at all, so it cannot leak the token (asserted
      // above) and does not even confirm the route shape. Asserting the status here pins the exemption
      // as narrow; if it ever widened to a prefix match this would fall through to 404 and fail.
      expect(unmatched.status).toBe(401);
      expect(securityEvents.slice(eventsBefore)).toHaveLength(4);
    },
  );
});

function createMemoryRateLimitRedis(): RedisClient {
  const buckets = new Map<string, number>();
  return {
    script: () => Promise.resolve("invitation-rate-limit-script"),
    evalsha: (
      _sha: string,
      _numberOfKeys: number,
      tokenKey: string,
      _timestampKey: string,
      maxTokens: number,
    ) => {
      const remaining = buckets.has(tokenKey) ? buckets.get(tokenKey)! : maxTokens;
      if (remaining < 1) return Promise.resolve([0, 0, 1]);
      buckets.set(tokenKey, remaining - 1);
      return Promise.resolve([remaining - 1, 1, 0]);
    },
  } as unknown as RedisClient;
}

describe("invitation verification rate limit", () => {
  integrationTest("rejects the eleventh same-IP request while isolating another IP", async () => {
    const token = await seedInvitation(activeSchool.id);
    const rateLimitedApp = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      database: sql,
      keyStore,
      redis: createMemoryRateLimitRedis(),
      jwtIssuer: TEST_JWT_ISSUER,
      jwtAudience: TEST_JWT_AUDIENCE,
    });

    const path = `${VERIFY_PREFIX}/${token}/verify`;
    for (let index = 0; index < 10; index += 1) {
      const response = await rateLimitedApp.request(path, {
        headers: { "x-forwarded-for": "198.51.100.10" },
      });
      expect(response.status).toBe(200);
    }

    const limited = await rateLimitedApp.request(path, {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("content-type")).toBe("application/problem+json");

    const otherIp = await rateLimitedApp.request(path, {
      headers: { "x-forwarded-for": "198.51.100.11" },
    });
    expect(otherIp.status).toBe(200);
  });
});
