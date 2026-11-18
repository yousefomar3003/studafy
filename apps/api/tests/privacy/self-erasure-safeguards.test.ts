/**
 * QA-042: erasing your own account always goes through the account-deletion safeguards.
 *
 * `POST /api/privacy/me/dsr {"request_type":"erasure"}` enqueued an immediate, irreversible erasure
 * on nothing but a bearer token: no 14-day grace period, and no re-entry of a member's password,
 * which `POST /api/account/deletion` requires. A borrowed or stolen student session could erase the
 * account outright. Self-service erasure is now refused on the DSR route with a pointer to the
 * account-deletion route; self-service export and school-filed erasure are unchanged.
 *
 *   TEST_DATABASE_URL=... TEST_REDIS_URL=... bun test tests/privacy/self-erasure-safeguards.test.ts
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { createRedisClient } from "../../src/redis";
import {
  authenticatedRequest,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";
import { fakeStorage } from "../harness/fake-storage";

import type { RedisClient } from "../../src/redis";
import type { TestApp, TestDatabase, TenantFixture } from "../harness";

const redisUrl = process.env.TEST_REDIS_URL;
const describeIt = integrationEnabled && redisUrl ? describe : describe.skip;

let database: TestDatabase | undefined;
let redis: RedisClient | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!integrationEnabled || !redisUrl) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
  redis = createRedisClient({
    url: redisUrl,
    logger: createLogger({ destination: () => undefined }),
  });
  const created = createTestApp({ database: database.sql, redis, storage: fakeStorage() });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  redis?.disconnect();
  await database?.cleanup();
});

const asStudent = () => ({
  schoolId: tenant.schoolId,
  userId: tenant.users[ROLES.STUDENT]!.id,
  roles: [ROLES.STUDENT],
  channel: "mobile" as const,
});

const file = (requestType: "export" | "erasure") =>
  authenticatedRequest(harness!, "POST", "/api/privacy/me/dsr", asStudent(), {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_type: requestType }),
  });

async function erasureRequests(): Promise<number> {
  const [row] = await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    return tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.data_subject_requests
      WHERE subject_user_id = ${tenant.users[ROLES.STUDENT]!.id}::uuid AND request_type = 'erasure'
    `;
  });
  return row!.n;
}

describeIt("self-service erasure safeguards (QA-042)", () => {
  test("an erasure filed on a bare session is refused and nothing is queued", async () => {
    const res = await file("erasure");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      ERROR_CODES.SELF_ERASURE_USE_ACCOUNT_DELETION,
    );
    expect(await erasureRequests()).toBe(0);
  });

  test("a self-service export is still accepted", async () => {
    expect((await file("export")).status).toBe(202);
  });
});
