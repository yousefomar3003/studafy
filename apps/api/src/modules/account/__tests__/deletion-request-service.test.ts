/**
 * Public account deletion (ST-302). The unit tests cover every path that must stop before the
 * database — captcha, cooldown, bad tokens. The integration tests (skipped unless
 * TEST_DATABASE_URL is set) run the whole flow: request -> emailed token -> confirm -> ST-301's
 * deletion in every school the address has an account in.
 */

import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import {
  createSchool,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { confirmAccountDeletion, requestAccountDeletion } from "../deletion-request-service";

import type { TestDatabase } from "../../../../tests/harness";
import type { PaymentProviderPort } from "../../subscriptions/ports/payment-provider";
import type { DeletionRequestDeps } from "../deletion-request-service";
import type { Queue } from "bullmq";
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

/** Enough of ioredis for the service: SET with EX/NX, GET, DEL. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string, _ex: "EX", _ttl: number, nx?: "NX") {
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

function fakeDeps(options: { database?: unknown; captchaSecretKey?: string } = {}) {
  const redis = fakeRedis();
  const deps = {
    database: (options.database ?? unusableDatabase) as never,
    denylist: null,
    paymentProviders: {
      stripe: { scheduleCancellation: async () => undefined } as unknown as PaymentProviderPort,
      tap: null,
    },
    maintenanceQueue: { add: async () => undefined } as unknown as Queue,
    siwa: null,
    redis: redis as never,
    captchaSecretKey: options.captchaSecretKey,
  } satisfies DeletionRequestDeps;
  return { deps, redis };
}

const unusableDatabase = new Proxy(() => undefined, {
  get() {
    throw new Error("database must not be touched on this path");
  },
  apply() {
    throw new Error("database must not be touched on this path");
  },
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CodedHttpException);
  return (error as CodedHttpException).code;
}

describe("requestAccountDeletion", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("rejects a failed captcha before touching Redis or the database", async () => {
    globalThis.fetch = (async () => Response.json({ success: false })) as unknown as typeof fetch;
    const { deps, redis } = fakeDeps({ captchaSecretKey: "secret" });

    const code = await codeOf(
      requestAccountDeletion(deps, { email: "a@example.com", captchaToken: "bad" }),
    );

    expect(code).toBe(ERROR_CODES.CAPTCHA_INVALID);
    expect(redis.store.size).toBe(0);
  });

  test("a repeat within the cooldown, in any letter case, returns quietly without a lookup", async () => {
    let lookups = 0;
    const { deps } = fakeDeps({
      database: {
        begin: async () => {
          lookups += 1;
        },
      },
    });

    await requestAccountDeletion(deps, { email: "a@example.com", captchaToken: "t" });
    await requestAccountDeletion(deps, { email: " A@Example.COM ", captchaToken: "t" });

    expect(lookups).toBe(1);
  });
});

describe("confirmAccountDeletion", () => {
  test.each(["", "not-hex", "A".repeat(64), "a".repeat(63)])(
    "a malformed token (%p) is invalid without a Redis read",
    async (token) => {
      const { deps, redis } = fakeDeps();
      redis.get = () => {
        throw new Error("redis must not be read");
      };

      expect(await codeOf(confirmAccountDeletion(deps, { token }))).toBe(
        ERROR_CODES.VERIFICATION_TOKEN_INVALID,
      );
    },
  );

  test("an unknown or expired token is invalid", async () => {
    const { deps } = fakeDeps();

    expect(await codeOf(confirmAccountDeletion(deps, { token: "a".repeat(64) }))).toBe(
      ERROR_CODES.VERIFICATION_TOKEN_INVALID,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------------------------

let database: TestDatabase | null = null;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

async function asAdmin<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  let result: T;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx as unknown as Sql);
  });
  return result!;
}

async function outboxRows(schoolId: string, eventName: string) {
  return asAdmin(database!.sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM app.outbox_events WHERE event_name = ${eventName}
    `;
  });
}

async function userState(schoolId: string, userId: string) {
  return asAdmin(database!.sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ status: string; audit: Record<string, unknown> | null }[]>`
      SELECT
        (SELECT status::text FROM app.users WHERE id = ${userId}) AS status,
        (SELECT new_values FROM app.audit_logs
          WHERE target_table = 'users' AND target_id = ${userId}::uuid AND action = 'delete') AS audit
    `;
    return row!;
  });
}

describe("public deletion flow", () => {
  integrationTest(
    "an emailed token deletes the address's accounts in every school",
    async () => {
      const sql = database!.sql;
      const email = `parent-${crypto.randomUUID().slice(0, 8)}@example.com`;
      const hill = await createSchool(sql, { name: "Hill School" });
      const lake = await createSchool(sql, { name: "Lake Academy" });
      const atHill = await createUser(sql, hill.id, { email });
      const atLake = await createUser(sql, lake.id, { email: email.toUpperCase() });
      const bystander = await createUser(sql, hill.id);
      const { deps, redis } = fakeDeps({ database: sql });

      await requestAccountDeletion(deps, { email: ` ${email.toUpperCase()} `, captchaToken: "t" });

      const requested = [
        ...(await outboxRows(hill.id, DOMAIN_EVENTS.ACCOUNT_DELETION_REQUESTED)),
        ...(await outboxRows(lake.id, DOMAIN_EVENTS.ACCOUNT_DELETION_REQUESTED)),
      ];
      expect(requested).toHaveLength(1);
      const payload = requested[0]!.payload as { token: string; schoolNames: string[] };
      expect([...payload.schoolNames].sort()).toEqual(["Hill School", "Lake Academy"]);
      // Only the hash of the token is stored.
      expect([...redis.store.keys()].some((k) => k.includes(payload.token))).toBe(false);

      const confirmed = await confirmAccountDeletion(deps, { token: payload.token });

      expect(confirmed.map((c) => c.schoolName).sort()).toEqual(["Hill School", "Lake Academy"]);
      for (const [schoolId, userId] of [
        [hill.id, atHill.id],
        [lake.id, atLake.id],
      ] as const) {
        const state = await userState(schoolId, userId);
        expect(state.status).toBe("archived");
        expect(state.audit).toMatchObject({ reason: "account_deletion", source: "web_request" });
        expect(await outboxRows(schoolId, DOMAIN_EVENTS.ACCOUNT_DELETED)).toHaveLength(1);
      }
      expect((await userState(hill.id, bystander.id)).status).toBe("active");

      // Single use.
      expect(await codeOf(confirmAccountDeletion(deps, { token: payload.token }))).toBe(
        ERROR_CODES.VERIFICATION_TOKEN_INVALID,
      );
    },
    30_000,
  );

  integrationTest("an address with no account gets the same outcome and no email", async () => {
    const school = await createSchool(database!.sql);
    const { deps, redis } = fakeDeps({ database: database!.sql });

    await requestAccountDeletion(deps, { email: "nobody@example.com", captchaToken: "t" });

    expect(await outboxRows(school.id, DOMAIN_EVENTS.ACCOUNT_DELETION_REQUESTED)).toHaveLength(0);
    // Only the cooldown key; no token was issued.
    expect(redis.store.size).toBe(1);
  });
});
