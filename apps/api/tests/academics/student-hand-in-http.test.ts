/**
 * A student hands work in from the mobile app, end to end over HTTP, with exactly the bodies the
 * generated Dart client sends.
 *
 * The app's submission flow is: create the submission (text, or nothing for an attachments-only
 * hand-in), then for each file mint an upload URL, PUT the bytes, and confirm. Until the client
 * stopped serialising unset optional fields as `null`, the create carried `"answers": null` (and
 * `"content": null` for attachments only) and the confirm `"checksum_sha256": null`; the API's
 * `.optional()` fields reject null, so every hand-in failed with 400 VALIDATION_FAILED. The
 * null-carrying bodies are pinned here too, so the contract the client relies on is explicit.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/academics/student-hand-in-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
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

import type { StorageService } from "../../src/lib/storage";
import type { TestApp, TestDatabase, TenantFixture } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

interface StoredObject {
  contentType: string;
  sizeBytes: number;
}

const objects = new Map<string, StoredObject>();
const storage: StorageService = {
  ttlSeconds: 900,
  check: async () => true,
  presign(key, _method, _contentType, ttlOverrideSeconds) {
    return {
      url: `https://storage.example/${key}?signed`,
      expiresAt: new Date(Date.now() + (ttlOverrideSeconds ?? 900) * 1000),
    };
  },
  async exists(key) {
    return objects.has(key);
  },
  async size(key) {
    return objects.get(key)?.sizeBytes ?? 0;
  },
  async head(key) {
    const object = objects.get(key);
    return object ? { contentType: object.contentType, sizeBytes: object.sizeBytes } : null;
  },
  async checksumSha256() {
    return "a".repeat(64);
  },
  async copy(source, destination) {
    const object = objects.get(source);
    if (object) objects.set(destination, { ...object });
  },
  async remove(key) {
    objects.delete(key);
  },
  async *list(prefix) {
    for (const [key, object] of objects) {
      if (key.startsWith(prefix)) yield { key, sizeBytes: object.sizeBytes };
    }
  },
};

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({
    database: database.sql,
    storage,
    uploadScanEnqueuer: async () => undefined,
  });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

async function newTenantWithAssignment(): Promise<{ tenant: TenantFixture; assignmentId: string }> {
  const tenant = await createFullTenant(database!.sql);
  await assignRole(database!.sql, tenant.schoolId, tenant.students[0]!.userId, ROLES.STUDENT);
  const assignmentId = await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.assignments (
        school_id, class_id, created_by_user_id, last_edited_by_user_id,
        title, status, assigned_at, due_at, max_score, allow_late_submission
      ) VALUES (
        ${tenant.schoolId}, ${tenant.cls.id}, ${tenant.teachers[0]!.userId},
        ${tenant.teachers[0]!.userId}, 'الجاذبيه', 'published',
        CURRENT_TIMESTAMP - interval '1 day', CURRENT_TIMESTAMP + interval '7 days', 100, true
      )
      RETURNING id
    `;
    return row!.id;
  });
  return { tenant, assignmentId };
}

function asStudent(tenant: TenantFixture, method: string, path: string, body: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    {
      schoolId: tenant.schoolId,
      userId: tenant.students[0]!.userId,
      roles: [ROLES.STUDENT],
      channel: "mobile",
    },
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

describeDb("student hand-in from the mobile app", () => {
  test("an attachments-only hand-in: empty create, upload-url, confirm without a checksum", async () => {
    const { tenant, assignmentId } = await newTenantWithAssignment();

    const created = await asStudent(
      tenant,
      "POST",
      `/api/academics/assignments/${assignmentId}/submissions`,
      {},
    );
    expect(created.status).toBe(201);
    const { id: submissionId } = (await created.json()) as { id: string };

    const base = `/api/academics/submissions/${submissionId}/attachments`;
    const minted = await asStudent(tenant, "POST", `${base}/upload-url`, {
      file_name: "واجب الجاذبية.jpg",
      content_type: "image/jpeg",
    });
    expect(minted.status).toBe(201);
    const { storage_key: storageKey } = (await minted.json()) as { storage_key: string };
    objects.set(storageKey, { contentType: "image/jpeg", sizeBytes: 3_000 });

    const confirmed = await asStudent(tenant, "POST", base, {
      storage_key: storageKey,
      content_type: "image/jpeg",
    });
    expect(confirmed.status).toBe(201);
  });

  test("a written answer hands in with only content", async () => {
    const { tenant, assignmentId } = await newTenantWithAssignment();
    const created = await asStudent(
      tenant,
      "POST",
      `/api/academics/assignments/${assignmentId}/submissions`,
      { content: "الجاذبية قوة تجذب الأجسام نحو الأرض." },
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { status: string; content: string };
    expect(body.status).toBe("submitted");
    expect(body.content).toBe("الجاذبية قوة تجذب الأجسام نحو الأرض.");
  });

  test("explicit nulls in optional fields are refused, which is why the client omits them", async () => {
    const { tenant, assignmentId } = await newTenantWithAssignment();
    const created = await asStudent(
      tenant,
      "POST",
      `/api/academics/assignments/${assignmentId}/submissions`,
      { content: "My answer.", answers: null },
    );
    expect(created.status).toBe(400);
  });
});
