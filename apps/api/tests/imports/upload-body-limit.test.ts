/**
 * QA-067: the student CSV upload refuses an oversized body before reading it.
 *
 * The route read `arrayBuffer()` and parsed the whole file before its 10,000-row check, with no
 * body limit (Bun's default is 128 MB), so one admin request -- or a stolen admin session -- could
 * hold a large share of API memory. A body over 5 MB is now refused with 413 as it streams in.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/imports/upload-body-limit.test.ts
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  authenticatedRequest,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";
import { fakeStorage } from "../harness/fake-storage";

import type { TestApp, TestDatabase, TenantFixture } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;
const MB = 1024 * 1024;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
  const created = createTestApp({ database: database.sql, storage: fakeStorage() });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

const upload = (body: string) =>
  authenticatedRequest(
    harness!,
    "POST",
    "/api/imports/students/upload",
    {
      schoolId: tenant.schoolId,
      userId: tenant.users[ROLES.ORG_ADMIN]!.id,
      roles: [ROLES.ORG_ADMIN],
      channel: "web",
    },
    { headers: { "Content-Type": "text/csv" }, body },
  );

describeDb("student CSV upload size (QA-067)", () => {
  test("a 6 MB body is refused with 413 before it is parsed", async () => {
    const big = "first_name,last_name\n" + "a,b\n".repeat((6 * MB) / 4);
    const res = await upload(big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe(ERROR_CODES.IMPORT_FILE_TOO_LARGE);
  });

  test("an ordinary file is not refused for its size", async () => {
    const res = await upload("first_name,last_name\nAda,Lovelace\n");
    expect(res.status).not.toBe(413);
  });
});
