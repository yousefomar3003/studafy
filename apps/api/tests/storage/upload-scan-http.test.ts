/**
 * Malware scanning of submission files, end to end over HTTP (security finding F-14).
 *
 * A student attaches a file to their submission; the API leaves it `scanning`, enqueues a
 * scan-upload job for the workers' file-scan queue, and withholds every download until the verdict
 * is in. The scanner itself (clamd, EICAR, quarantine copy) is covered by
 * apps/workers/src/queues/scan/scan-upload.worker.test.ts; here its verdict is applied to the row
 * exactly as the worker writes it, and the read paths are checked against it: an infected file is
 * never downloadable, a clean one is.
 *
 * Message images get the same treatment in tests/messaging/messaging-safety-http.test.ts.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/storage/upload-scan-http.test.ts
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
import type { UploadScanRequest } from "../../src/lib/storage/upload-scan";
import type { TestApp, TestDatabase, TenantFixture } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

// ---------------------------------------------------------------------------
// In-memory object storage
// ---------------------------------------------------------------------------

interface StoredObject {
  contentType: string;
  sizeBytes: number;
}

function fakeStorage(): StorageService & { objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  const base: StorageService = {
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
  return Object.assign(base, { objects });
}

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
const storage = fakeStorage();
const scanJobs: UploadScanRequest[] = [];

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({
    database: database.sql,
    storage,
    uploadScanEnqueuer: async (requests) => {
      scanJobs.push(...requests);
    },
  });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface World {
  tenant: TenantFixture;
  studentUserId: string;
  submissionId: string;
}

/** A published assignment in the fixture class and the enrolled student's submission to it. */
async function buildWorld(): Promise<World> {
  const tenant = await createFullTenant(database!.sql);
  const student = tenant.students[0]!;
  await assignRole(database!.sql, tenant.schoolId, student.userId, ROLES.STUDENT);
  const submissionId = await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    const [assignment] = await tx<{ id: string }[]>`
      INSERT INTO app.assignments (
        school_id, class_id, created_by_user_id, last_edited_by_user_id,
        title, status, assigned_at, due_at, max_score, allow_late_submission
      ) VALUES (
        ${tenant.schoolId}, ${tenant.cls.id}, ${tenant.users.INSTRUCTOR.id},
        ${tenant.users.INSTRUCTOR.id}, 'Essay', 'published', CURRENT_TIMESTAMP - interval '1 day',
        CURRENT_TIMESTAMP + interval '7 days', 100, true
      )
      RETURNING id
    `;
    const [submission] = await tx<{ id: string }[]>`
      INSERT INTO app.assignment_submissions (
        school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at
      ) VALUES (
        ${tenant.schoolId}, ${assignment!.id}, ${student.id}, ${student.userId},
        'submitted', CURRENT_TIMESTAMP
      )
      RETURNING id
    `;
    return submission!.id;
  });
  return { tenant, studentUserId: student.userId, submissionId };
}

function asStudent(world: World, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    {
      schoolId: world.tenant.schoolId,
      userId: world.studentUserId,
      roles: [ROLES.STUDENT],
      channel: "mobile",
    },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

interface AttachmentBody {
  id: string;
  download_url: string | null;
}

/** Upload-url, PUT (into the fake bucket), confirm: the student's three steps. */
async function attach(
  world: World,
  fileName: string,
): Promise<{
  attachment: AttachmentBody;
  permanentKey: string;
}> {
  const base = `/api/academics/submissions/${world.submissionId}/attachments`;
  const minted = await asStudent(world, "POST", `${base}/upload-url`, {
    file_name: fileName,
    content_type: "application/pdf",
  });
  expect(minted.status).toBe(201);
  const { storage_key: tempKey } = (await minted.json()) as { storage_key: string };
  storage.objects.set(tempKey, { contentType: "application/pdf", sizeBytes: 68 });

  const confirmed = await asStudent(world, "POST", base, {
    storage_key: tempKey,
    content_type: "application/pdf",
  });
  expect(confirmed.status).toBe(201);
  return {
    attachment: (await confirmed.json()) as AttachmentBody,
    permanentKey: tempKey.replace(/^temp\//, "permanent/"),
  };
}

/** Apply the file-scan worker's verdict to the row, as scan-upload.worker.ts writes it. */
async function recordScanVerdict(
  schoolId: string,
  storageKey: string,
  verdict: "clean" | "quarantined",
): Promise<void> {
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const result = await tx`
      UPDATE app.submission_attachments SET scan_status = ${verdict}::app.upload_scan_status
      WHERE storage_key = ${storageKey} AND scan_status = 'scanning'
    `;
    expect(result.count).toBe(1);
  });
}

async function listedAttachment(world: World, attachmentId: string): Promise<AttachmentBody> {
  const res = await asStudent(world, "GET", `/api/academics/submissions/${world.submissionId}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { attachments: AttachmentBody[] };
  return body.attachments.find((attachment) => attachment.id === attachmentId)!;
}

function gatewayDownload(world: World, attachmentId: string) {
  return asStudent(world, "GET", `/api/storage/downloads/submission/${attachmentId}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeDb("submission files are malware-scanned before anyone can download them", () => {
  test("a new file is held back and handed to the scanner", async () => {
    const world = await buildWorld();
    const { attachment, permanentKey } = await attach(world, "essay.pdf");

    expect(attachment.download_url).toBeNull();
    expect(scanJobs).toContainEqual({
      target: "submission_attachment",
      schoolId: world.tenant.schoolId,
      storageKey: permanentKey,
    });
    expect((await listedAttachment(world, attachment.id)).download_url).toBeNull();
    expect((await gatewayDownload(world, attachment.id)).status).toBe(404);
  });

  test("an infected (EICAR) file is quarantined and never downloadable", async () => {
    const world = await buildWorld();
    const { attachment, permanentKey } = await attach(world, "eicar.pdf");
    await recordScanVerdict(world.tenant.schoolId, permanentKey, "quarantined");

    expect((await listedAttachment(world, attachment.id)).download_url).toBeNull();
    expect((await gatewayDownload(world, attachment.id)).status).toBe(404);
  });

  test("a clean file is downloadable once its scan passes", async () => {
    const world = await buildWorld();
    const { attachment, permanentKey } = await attach(world, "clean.pdf");
    await recordScanVerdict(world.tenant.schoolId, permanentKey, "clean");

    expect((await listedAttachment(world, attachment.id)).download_url).toContain(permanentKey);
    const res = await gatewayDownload(world, attachment.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { download_url: string }).download_url).toContain(permanentKey);
  });
});
