/**
 * QA-060: a school's administrator cannot act on Studafy's own staff.
 *
 * Platform staff (SUPER_ADMIN, SUPPORT_AGENT) sit in the platform tenant's school. Role changes
 * already refused to touch them, but the ORG_ADMIN of that school could still read, suspend,
 * deactivate or file a GDPR erasure against a SUPER_ADMIN through the ordinary user routes. Those
 * now answer 404 for a platform-staff target, exactly like a user of another school.
 *
 *   TEST_DATABASE_URL=postgres://... TEST_REDIS_URL=... bun test tests/security/platform-staff-protection.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { createRedisClient } from "../../src/redis";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";
import { fakeStorage } from "../harness/fake-storage";

import type { RedisClient } from "../../src/redis";
import type { TestApp, TestDatabase } from "../harness";

const redisUrl = process.env.TEST_REDIS_URL;
const describeIt = integrationEnabled && redisUrl ? describe : describe.skip;

let database: TestDatabase | undefined;
let redis: RedisClient | undefined;
let harness: TestApp | undefined;
let schoolId: string;
let adminId: string;
let superAdminId: string;

beforeAll(async () => {
  if (!integrationEnabled || !redisUrl) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  schoolId = (await createSchool(database.sql)).id;
  adminId = (await createUser(database.sql, schoolId)).id;
  await assignRole(database.sql, schoolId, adminId, ROLES.ORG_ADMIN);
  superAdminId = (await createUser(database.sql, schoolId)).id;
  // assignRole registers the school as the platform tenant for a platform role.
  await assignRole(database.sql, schoolId, superAdminId, ROLES.SUPER_ADMIN);
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

const asAdmin = (method: string, path: string, body?: unknown) =>
  authenticatedRequest(
    harness!,
    method,
    path,
    { schoolId, userId: adminId, roles: [ROLES.ORG_ADMIN], channel: "web" },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );

async function superAdminStatus(): Promise<string> {
  const [row] = await database!.sql<{ status: string }[]>`
    SELECT status::text AS status FROM app.users WHERE id = ${superAdminId}::uuid
  `;
  return row!.status;
}

describeIt("platform staff are out of a school admin's reach (QA-060)", () => {
  test("GET /api/users/{id} does not reveal a SUPER_ADMIN", async () => {
    expect((await asAdmin("GET", `/api/users/${superAdminId}`)).status).toBe(404);
  });

  test("PATCH status cannot suspend a SUPER_ADMIN", async () => {
    const res = await asAdmin("PATCH", `/api/users/${superAdminId}`, { status: "suspended" });
    expect(res.status).toBe(404);
    expect(await superAdminStatus()).toBe("active");
  });

  test("deactivate cannot touch a SUPER_ADMIN", async () => {
    const res = await asAdmin("POST", `/api/users/${superAdminId}/deactivate`);
    expect(res.status).toBe(404);
    expect(await superAdminStatus()).toBe("active");
  });

  test("a GDPR erasure cannot be filed against a SUPER_ADMIN", async () => {
    const res = await asAdmin("POST", "/api/privacy/dsr", {
      subject_user_id: superAdminId,
      request_type: "erasure",
    });
    expect(res.status).toBe(404);
  });
});
