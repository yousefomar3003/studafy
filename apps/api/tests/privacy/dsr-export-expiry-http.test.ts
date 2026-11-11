/**
 * A completed export's download link (`GET /api/privacy/dsr/{requestId}`) is handed out until the
 * data retention sweep deletes the stored bundle, 30 days after completion (000188's
 * export_deleted_at); after that the request still answers, with no link. Requires a live
 * PostgreSQL instance, gated on TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/privacy/dsr-export-expiry-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  authenticatedRequest,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { StorageService } from "../../src/lib/storage";
import type { TenantFixture, TestApp, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

const presigned: string[] = [];
const storage: StorageService = {
  ttlSeconds: 900,
  check: async () => true,
  presign(key, _method, _contentType, ttl) {
    presigned.push(key);
    return {
      url: `https://storage.example/${encodeURIComponent(key)}?signed`,
      expiresAt: new Date(Date.now() + (ttl ?? 900) * 1000),
    };
  },
  exists: async () => false,
  size: async () => 0,
  head: async () => null,
  checksumSha256: async () => "",
  copy: async () => undefined,
  remove: async () => undefined,
  // eslint-disable-next-line require-yield -- an empty bucket
  async *list() {
    return;
  },
};

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql, storage });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

/** A completed user export, finished [daysAgo] days ago, its bundle deleted or not. */
async function completedExport(
  fixture: TenantFixture,
  daysAgo: number,
  bundleDeleted: boolean,
): Promise<{ id: string; key: string }> {
  const id = crypto.randomUUID();
  const key = `dsr-exports/${fixture.schoolId}/${id}/manifest.json`;
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
    await tx`
      INSERT INTO app.data_subject_requests
        (id, school_id, request_type, subject_scope, reason, subject_user_id, requested_by_user_id,
         status, storage_key, sla_due_at, created_at, completed_at, updated_at, export_deleted_at)
      VALUES (
        ${id}::uuid, ${fixture.schoolId}::uuid, 'export', 'user', 'user_request',
        ${fixture.users.PARENT!.id}::uuid, ${fixture.users.ORG_ADMIN!.id}::uuid, 'completed', ${key},
        now() - make_interval(days => ${daysAgo + 1}) + interval '30 days',
        now() - make_interval(days => ${daysAgo + 1}),
        now() - make_interval(days => ${daysAgo}),
        now(),
        CASE WHEN ${bundleDeleted} THEN now() END
      )
    `;
  });
  return { id, key };
}

describeDb("GET /api/privacy/dsr/{requestId} after the export bundle expires", () => {
  test("links a live bundle, and not one the retention sweep deleted", async () => {
    const fixture = await createFullTenant(database!.sql);
    const admin = {
      schoolId: fixture.schoolId,
      userId: fixture.users.ORG_ADMIN!.id,
      roles: [ROLES.ORG_ADMIN],
    };
    const live = await completedExport(fixture, 5, false);
    const deleted = await completedExport(fixture, 31, true);

    const liveRes = await authenticatedRequest(
      harness!,
      "GET",
      `/api/privacy/dsr/${live.id}`,
      admin,
    );
    expect(liveRes.status).toBe(200);
    expect(((await liveRes.json()) as { download_url: string | null }).download_url).toContain(
      "storage.example",
    );

    const deletedRes = await authenticatedRequest(
      harness!,
      "GET",
      `/api/privacy/dsr/${deleted.id}`,
      admin,
    );
    expect(deletedRes.status).toBe(200);
    expect(await deletedRes.json()).toMatchObject({
      id: deleted.id,
      status: "completed",
      download_url: null,
      download_url_expires_at: null,
    });
    expect(presigned).toEqual([live.key]);
  });
});
