/**
 * QA-036: confirm promotes the object it inspected, not whatever is at the key by the time it copies.
 *
 * Confirm HEADs the staged object (type, size, quota), then CopyObjects it to permanent/. The client
 * still holds a presigned PUT for the temp key, so it could re-PUT a far larger object between the
 * two: the quota was charged on the small size and the large one promoted. The copy is now
 * conditional on the ETag seen at HEAD; a swapped object fails it, confirm answers 409, nothing is
 * promoted and the reservation is handed back.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/storage/upload-swap.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
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
const MIB = 1024 * 1024;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
const storage = fakeStorage();

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
  await assignRole(database.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
  const created = createTestApp({ database: database.sql, storage });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

const teacher = () => ({
  schoolId: tenant.schoolId,
  userId: tenant.teachers[0]!.userId,
  roles: [ROLES.INSTRUCTOR],
  channel: "web" as const,
});

const post = (path: string, body: unknown) =>
  authenticatedRequest(harness!, "POST", path, teacher(), {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function meter(): Promise<number> {
  const [row] = await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    return tx<{ bytes_used: string }[]>`
      SELECT bytes_used::text AS bytes_used FROM app.storage_usage_meters
      WHERE school_id = ${tenant.schoolId}::uuid
    `;
  });
  return Number(row?.bytes_used ?? 0);
}

describeDb("staged upload swapped after inspection (QA-036)", () => {
  test("a re-PUT between HEAD and copy is refused: 409, nothing promoted, quota untouched", async () => {
    const requested = await post("/api/storage/uploads/request-upload", {
      content_class: "assignment.attachment",
      file_name: "small.pdf",
      content_type: "application/pdf",
      size_bytes: 1024,
    });
    expect(requested.status).toBe(201);
    const { storage_key: tempKey } = (await requested.json()) as { storage_key: string };
    storage.objects.set(tempKey, { contentType: "application/pdf", sizeBytes: 1024 });
    const before = await meter();

    // The client's second PUT lands after confirm's HEAD and before its copy.
    const copy = storage.copy.bind(storage);
    storage.copy = async (source, destination, options) => {
      storage.objects.set(source, { contentType: "application/pdf", sizeBytes: 20 * MIB });
      return copy(source, destination, options);
    };
    try {
      const confirmed = await post("/api/storage/uploads/confirm", {
        content_class: "assignment.attachment",
        storage_key: tempKey,
      });
      expect(confirmed.status).toBe(409);
    } finally {
      storage.copy = copy;
    }

    expect([...storage.objects.keys()].some((k) => k.startsWith("permanent/"))).toBe(false);
    expect(await meter()).toBe(before);
  });

  test("an untouched upload still confirms", async () => {
    const requested = await post("/api/storage/uploads/request-upload", {
      content_class: "assignment.attachment",
      file_name: "fine.pdf",
      content_type: "application/pdf",
      size_bytes: 2048,
    });
    const { storage_key: tempKey } = (await requested.json()) as { storage_key: string };
    storage.objects.set(tempKey, { contentType: "application/pdf", sizeBytes: 2048 });
    const confirmed = await post("/api/storage/uploads/confirm", {
      content_class: "assignment.attachment",
      storage_key: tempKey,
    });
    expect(confirmed.status).toBe(200);
  });
});
