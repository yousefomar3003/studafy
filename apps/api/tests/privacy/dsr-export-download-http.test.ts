/**
 * A completed export's download link (`GET /api/privacy/dsr/{requestId}`): it is signed for the
 * export's ZIP archive -- the key the workers' export sets as `storage_key`, under the request's
 * own dsr-exports/ prefix -- for an hour, and never for a key outside that prefix. Requires a live
 * PostgreSQL instance, gated on TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/privacy/dsr-export-download-http.test.ts
 */

import { ROLES, dsrExportArchiveKey } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DSR_EXPORT_LINK_TTL_SECONDS } from "../../src/modules/privacy/routes";
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

/** Records what was signed; nothing else is called by the status route. */
function signingStorage() {
  const presigned: { key: string; method: string; ttl: number | undefined }[] = [];
  const unused = () => {
    throw new Error("not used by the status route");
  };
  const service: StorageService = {
    ttlSeconds: 900,
    check: async () => true,
    presign(key, method, _contentType, ttl) {
      presigned.push({ key, method, ttl });
      return {
        url: `https://storage.example/${encodeURIComponent(key)}?signed`,
        expiresAt: new Date(Date.now() + (ttl ?? 900) * 1000),
      };
    },
    exists: unused,
    size: unused,
    head: unused,
    checksumSha256: unused,
    copy: unused,
    remove: unused,
    list: unused,
  };
  return Object.assign(service, { presigned });
}

const storage = signingStorage();
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

/** A per-person export, completed with `storageKey(requestId)` as the worker would, or queued. */
async function exportRequest(
  fixture: TenantFixture,
  storageKey: ((requestId: string) => string) | null,
): Promise<string> {
  const requestId = crypto.randomUUID();
  const key = storageKey?.(requestId) ?? null;
  await database!.sql`
    INSERT INTO app.data_subject_requests
      (id, school_id, request_type, subject_scope, reason, subject_user_id, requested_by_user_id,
       status, storage_key, sla_due_at, started_at, completed_at)
    VALUES (
      ${requestId}, ${fixture.schoolId}, 'export', 'user'::app.dsr_subject_scope,
      'user_request'::app.dsr_reason, ${fixture.users.PARENT!.id}, ${fixture.users.ORG_ADMIN!.id},
      ${key ? "completed" : "queued"}::app.dsr_status, ${key},
      now() + interval '30 days', ${key ? new Date() : null}, ${key ? new Date() : null}
    )
  `;
  return requestId;
}

async function status(fixture: TenantFixture, requestId: string) {
  const res = await authenticatedRequest(harness!, "GET", `/api/privacy/dsr/${requestId}`, {
    schoolId: fixture.schoolId,
    userId: fixture.users.ORG_ADMIN!.id,
    roles: [ROLES.ORG_ADMIN],
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    status: string;
    download_url: string | null;
    download_url_expires_at: string | null;
  };
}

describeDb("GET /api/privacy/dsr/{requestId} download link", () => {
  test("a completed export's link is a one-hour GET of its ZIP archive", async () => {
    const fixture = await createFullTenant(database!.sql);
    const requestId = await exportRequest(fixture, (id) =>
      dsrExportArchiveKey(fixture.schoolId, id),
    );
    const archiveKey = dsrExportArchiveKey(fixture.schoolId, requestId);
    expect(archiveKey).toBe(`dsr-exports/${fixture.schoolId}/${requestId}/export.zip`);

    const before = Date.now();
    const body = await status(fixture, requestId);

    expect(body.status).toBe("completed");
    expect(storage.presigned.at(-1)).toEqual({
      key: archiveKey,
      method: "GET",
      ttl: DSR_EXPORT_LINK_TTL_SECONDS,
    });
    expect(DSR_EXPORT_LINK_TTL_SECONDS).toBe(3600);
    expect(body.download_url).toBe(
      `https://storage.example/${encodeURIComponent(archiveKey)}?signed`,
    );
    const expiresIn = Date.parse(body.download_url_expires_at!) - before;
    expect(expiresIn).toBeGreaterThan(3590 * 1000);
    expect(expiresIn).toBeLessThan(3610 * 1000);
  });

  test("a key outside the request's own export prefix is never signed", async () => {
    const fixture = await createFullTenant(database!.sql);
    const signed = storage.presigned.length;
    for (const foreign of [
      () => `permanent/${fixture.schoolId}/${crypto.randomUUID()}/homework.pdf`,
      () => dsrExportArchiveKey(fixture.schoolId, crypto.randomUUID()),
    ]) {
      const requestId = await exportRequest(fixture, foreign);
      const body = await status(fixture, requestId);
      expect(body.status).toBe("completed");
      expect(body.download_url).toBeNull();
      expect(body.download_url_expires_at).toBeNull();
    }
    expect(storage.presigned.length).toBe(signed);
  });

  test("an export that has not finished has no link", async () => {
    const fixture = await createFullTenant(database!.sql);
    const requestId = await exportRequest(fixture, null);
    const body = await status(fixture, requestId);
    expect(body.status).toBe("queued");
    expect(body.download_url).toBeNull();
  });
});
