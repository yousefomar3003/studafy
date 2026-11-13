/**
 * Deleting a file frees its space, end to end over HTTP.
 *
 * Before this, every delete removed only the row: the stored object stayed in permanent/ and kept
 * counting toward the school's storage quota, so a full school could not free space by deleting
 * files. Each delete path below now removes the object once its transaction has committed and
 * releases exactly the bytes it removed (src/modules/storage/free-objects.ts). A key another row
 * still points at is kept, and a bucket failure never fails the delete.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/storage/delete-frees-storage-http.test.ts
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
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

// ---------------------------------------------------------------------------
// In-memory object storage
// ---------------------------------------------------------------------------

interface StoredObject {
  contentType: string;
  sizeBytes: number;
}

function fakeStorage(): StorageService & {
  objects: Map<string, StoredObject>;
  failRemove: boolean;
} {
  const objects = new Map<string, StoredObject>();
  const state = { failRemove: false };
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
      if (state.failRemove && key.startsWith("permanent/")) throw new Error("bucket unavailable");
      objects.delete(key);
    },
    async *list(prefix) {
      for (const [key, object] of objects) {
        if (key.startsWith(prefix)) yield { key, sizeBytes: object.sizeBytes };
      }
    },
  };
  return Object.defineProperty(Object.assign(base, { objects }), "failRemove", {
    get: () => state.failRemove,
    set: (value: boolean) => {
      state.failRemove = value;
    },
  }) as StorageService & { objects: Map<string, StoredObject>; failRemove: boolean };
}

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
const storage = fakeStorage();

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function asAdmin<T>(schoolId: string, fn: (tx: TestDatabase["sql"]) => Promise<T>) {
  return database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx as unknown as TestDatabase["sql"]);
  }) as Promise<T>;
}

async function meter(schoolId: string): Promise<number> {
  const [row] = await asAdmin(
    schoolId,
    (tx) => tx<{ bytes_used: string }[]>`
      SELECT bytes_used::text AS bytes_used FROM app.storage_usage_meters
      WHERE school_id = ${schoolId}::uuid
    `,
  );
  return Number(row?.bytes_used ?? 0);
}

async function setMeter(schoolId: string, bytes: number): Promise<void> {
  await asAdmin(schoolId, (tx) => tx`SELECT app.set_storage_usage(${bytes})`);
}

function request(
  tenant: TenantFixture,
  as: { userId: string; roles: Role[]; channel?: "web" | "mobile" },
  method: string,
  path: string,
  body?: unknown,
) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    {
      schoolId: tenant.schoolId,
      userId: as.userId,
      roles: as.roles,
      channel: as.channel ?? "web",
    },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

/** The class's lead teacher, who may manage its assignments and materials. */
function teacher(tenant: TenantFixture) {
  return { userId: tenant.teachers[0]!.userId, roles: [ROLES.INSTRUCTOR] };
}

async function newTenant(): Promise<TenantFixture> {
  const tenant = await createFullTenant(database!.sql);
  await assignRole(database!.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
  return tenant;
}

async function createAssignment(tenant: TenantFixture, status: "draft" | "published") {
  const [assignment] = await asAdmin(
    tenant.schoolId,
    (tx) => tx<{ id: string }[]>`
      INSERT INTO app.assignments (
        school_id, class_id, created_by_user_id, last_edited_by_user_id,
        title, status, assigned_at, due_at, max_score, allow_late_submission
      ) VALUES (
        ${tenant.schoolId}, ${tenant.cls.id}, ${tenant.teachers[0]!.userId},
        ${tenant.teachers[0]!.userId}, 'Worksheet', ${status},
        CASE WHEN ${status} = 'draft' THEN NULL ELSE CURRENT_TIMESTAMP - interval '1 day' END,
        CURRENT_TIMESTAMP + interval '7 days', 100, true
      )
      RETURNING id
    `,
  );
  return assignment!.id;
}

/** Upload-url, PUT into the fake bucket, confirm: a teacher attaching a file to an assignment. */
async function attachToAssignment(
  tenant: TenantFixture,
  assignmentId: string,
  sizeBytes: number,
): Promise<{ attachmentId: string; permanentKey: string }> {
  const base = `/api/academics/assignments/${assignmentId}/attachments`;
  const minted = await request(tenant, teacher(tenant), "POST", `${base}/upload-url`, {
    file_name: "worksheet.pdf",
    content_type: "application/pdf",
  });
  expect(minted.status).toBe(201);
  const { storage_key: tempKey } = (await minted.json()) as { storage_key: string };
  storage.objects.set(tempKey, { contentType: "application/pdf", sizeBytes });
  const confirmed = await request(tenant, teacher(tenant), "POST", base, {
    storage_key: tempKey,
    content_type: "application/pdf",
  });
  expect(confirmed.status).toBe(201);
  const { id } = (await confirmed.json()) as { id: string };
  return { attachmentId: id, permanentKey: tempKey.replace(/^temp\//, "permanent/") };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeDb("deleting a file frees its storage", () => {
  test("confirming without content_type (as the mobile app does) keeps the uploaded type", async () => {
    const tenant = await newTenant();
    const assignmentId = await createAssignment(tenant, "published");
    const base = `/api/academics/assignments/${assignmentId}/attachments`;
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const minted = await request(tenant, teacher(tenant), "POST", `${base}/upload-url`, {
      file_name: "فلسطين كما خلقها الله - نسخة النشر.docx",
      content_type: docx,
    });
    expect(minted.status).toBe(201);
    const { storage_key: tempKey } = (await minted.json()) as { storage_key: string };
    storage.objects.set(tempKey, { contentType: docx, sizeBytes: 2_000 });

    const confirmed = await request(tenant, teacher(tenant), "POST", base, {
      storage_key: tempKey,
    });

    expect(confirmed.status).toBe(201);
    const body = (await confirmed.json()) as { mime_type?: string; content_type?: string };
    expect(body.mime_type ?? body.content_type).toBe(docx);
  });

  test("an assignment attachment: the object goes and the meter drops by its size", async () => {
    const tenant = await newTenant();
    const assignmentId = await createAssignment(tenant, "draft");
    const { attachmentId, permanentKey } = await attachToAssignment(tenant, assignmentId, 4_000);
    expect(storage.objects.has(permanentKey)).toBe(true);
    expect(await meter(tenant.schoolId)).toBe(4_000);

    const res = await request(
      tenant,
      teacher(tenant),
      "DELETE",
      `/api/academics/assignments/${assignmentId}/attachments/${attachmentId}`,
    );
    expect(res.status).toBe(204);
    expect(storage.objects.has(permanentKey)).toBe(false);
    expect(await meter(tenant.schoolId)).toBe(0);
  });

  test("hard-deleting an assignment frees its attachments", async () => {
    const tenant = await newTenant();
    const assignmentId = await createAssignment(tenant, "draft");
    const first = await attachToAssignment(tenant, assignmentId, 1_000);
    const second = await attachToAssignment(tenant, assignmentId, 2_000);
    expect(await meter(tenant.schoolId)).toBe(3_000);

    const res = await request(
      tenant,
      teacher(tenant),
      "DELETE",
      `/api/academics/assignments/${assignmentId}`,
    );
    expect(res.status).toBe(204);
    expect(storage.objects.has(first.permanentKey)).toBe(false);
    expect(storage.objects.has(second.permanentKey)).toBe(false);
    expect(await meter(tenant.schoolId)).toBe(0);
  });

  test("a submission attachment the student removes is freed", async () => {
    const tenant = await newTenant();
    const student = tenant.students[0]!;
    await assignRole(database!.sql, tenant.schoolId, student.userId, ROLES.STUDENT);
    const assignmentId = await createAssignment(tenant, "published");
    const [submission] = await asAdmin(
      tenant.schoolId,
      (tx) => tx<{ id: string }[]>`
        INSERT INTO app.assignment_submissions (
          school_id, assignment_id, student_id, last_edited_by_user_id, status
        ) VALUES (
          ${tenant.schoolId}, ${assignmentId}, ${student.id}, ${student.userId}, 'draft'
        )
        RETURNING id
      `,
    );
    const asStudent = {
      userId: student.userId,
      roles: [ROLES.STUDENT],
      channel: "mobile" as const,
    };
    const base = `/api/academics/submissions/${submission!.id}/attachments`;
    const minted = await request(tenant, asStudent, "POST", `${base}/upload-url`, {
      file_name: "essay.pdf",
      content_type: "application/pdf",
    });
    expect(minted.status).toBe(201);
    const { storage_key: tempKey } = (await minted.json()) as { storage_key: string };
    storage.objects.set(tempKey, { contentType: "application/pdf", sizeBytes: 680 });
    const confirmed = await request(tenant, asStudent, "POST", base, {
      storage_key: tempKey,
      content_type: "application/pdf",
    });
    expect(confirmed.status).toBe(201);
    const { id: attachmentId } = (await confirmed.json()) as { id: string };
    const permanentKey = tempKey.replace(/^temp\//, "permanent/");
    expect(await meter(tenant.schoolId)).toBe(680);

    const res = await request(tenant, asStudent, "DELETE", `${base}/${attachmentId}`);
    expect(res.status).toBe(204);
    expect(storage.objects.has(permanentKey)).toBe(false);
    expect(await meter(tenant.schoolId)).toBe(0);
  });

  test("a material is freed together with its thumbnail and preview", async () => {
    const tenant = await newTenant();
    const started = await request(
      tenant,
      teacher(tenant),
      "POST",
      "/api/academics/materials/upload",
      {
        class_id: tenant.cls.id,
        title: "Cells",
        original_file_name: `cells-${crypto.randomUUID().slice(0, 8)}.pdf`,
        mime_type: "application/pdf",
        size_bytes: 5_000,
      },
    );
    expect(started.status).toBe(201);
    const { storage_key: key } = (await started.json()) as { storage_key: string };
    storage.objects.set(key, { contentType: "application/pdf", sizeBytes: 5_000 });
    const [material] = await asAdmin(
      tenant.schoolId,
      (tx) => tx<{ id: string }[]>`SELECT id FROM app.materials WHERE storage_key = ${key}`,
    );
    const materialId = material!.id;
    const confirmed = await request(
      tenant,
      teacher(tenant),
      "POST",
      `/api/academics/materials/${materialId}/confirm`,
      { storage_key: key },
    );
    expect(confirmed.status).toBe(200);

    // What the derivation worker writes for a rendered material.
    const thumbnail = `permanent/${tenant.schoolId}/${materialId}/thumbnail.jpg`;
    const preview = `permanent/${tenant.schoolId}/${materialId}/preview.jpg`;
    storage.objects.set(thumbnail, { contentType: "image/jpeg", sizeBytes: 100 });
    storage.objects.set(preview, { contentType: "image/jpeg", sizeBytes: 300 });
    await asAdmin(
      tenant.schoolId,
      (tx) => tx`
        UPDATE app.materials SET thumbnail_key = ${thumbnail}, preview_key = ${preview}
        WHERE id = ${materialId}
      `,
    );
    await setMeter(tenant.schoolId, 5_400);

    const res = await request(
      tenant,
      teacher(tenant),
      "DELETE",
      `/api/academics/materials/${materialId}`,
    );
    expect(res.status).toBe(204);
    expect(storage.objects.has(key)).toBe(false);
    expect(storage.objects.has(thumbnail)).toBe(false);
    expect(storage.objects.has(preview)).toBe(false);
    expect(await meter(tenant.schoolId)).toBe(0);
  });

  test("a file another row still points at is kept", async () => {
    const tenant = await newTenant();
    const assignmentId = await createAssignment(tenant, "draft");
    const { attachmentId, permanentKey } = await attachToAssignment(tenant, assignmentId, 900);
    // An expense may be given any of its school's permanent/ keys.
    await asAdmin(
      tenant.schoolId,
      (tx) => tx`
        INSERT INTO app.expense_cache (
          school_id, document_type, category, vendor, currency_id, amount_minor,
          erpnext_docname, erpnext_status, last_synced_at, attachment_storage_key
        ) VALUES (
          ${tenant.schoolId}, 'expense_claim', 'Supplies', 'Stationer',
          (SELECT id FROM app.currencies WHERE code = 'USD'), 100,
          ${`EXP-${crypto.randomUUID().slice(0, 8)}`}, 'Draft', CURRENT_TIMESTAMP, ${permanentKey}
        )
      `,
    );

    const res = await request(
      tenant,
      teacher(tenant),
      "DELETE",
      `/api/academics/assignments/${assignmentId}/attachments/${attachmentId}`,
    );
    expect(res.status).toBe(204);
    expect(storage.objects.has(permanentKey)).toBe(true);
    expect(await meter(tenant.schoolId)).toBe(900);
  });

  test("a replaced expense receipt is kept, and its audit row names it", async () => {
    const tenant = await newTenant();
    const oldReceipt = `permanent/${tenant.schoolId}/${crypto.randomUUID()}/receipt.pdf`;
    storage.objects.set(oldReceipt, { contentType: "application/pdf", sizeBytes: 300 });
    const docname = `EXP-${crypto.randomUUID().slice(0, 8)}`;
    const [expense] = await asAdmin(
      tenant.schoolId,
      (tx) => tx<{ id: string }[]>`
        INSERT INTO app.expense_cache (
          school_id, document_type, category, vendor, currency_id, amount_minor,
          erpnext_docname, erpnext_status, last_synced_at, attachment_storage_key
        ) VALUES (
          ${tenant.schoolId}, 'expense_claim', 'Supplies', 'Stationer',
          (SELECT id FROM app.currencies WHERE code = 'USD'), 100,
          ${docname}, 'Draft', CURRENT_TIMESTAMP, ${oldReceipt}
        )
        RETURNING id
      `,
    );
    const tempKey = `temp/${tenant.schoolId}/${crypto.randomUUID()}/new-receipt.pdf`;
    storage.objects.set(tempKey, { contentType: "application/pdf", sizeBytes: 400 });

    const res = await request(
      tenant,
      { userId: tenant.users.ORG_ADMIN.id, roles: [ROLES.ORG_ADMIN] },
      "POST",
      `/api/finance/expenses/${expense!.id}/attachments`,
      { storage_key: tempKey },
    );
    expect(res.status).toBe(200);
    expect(storage.objects.has(oldReceipt)).toBe(true);

    const [audit] = await asAdmin(
      tenant.schoolId,
      (tx) => tx<{ old_key: string | null }[]>`
        SELECT old_values->>'attachment_storage_key' AS old_key FROM app.audit_logs
        WHERE school_id = ${tenant.schoolId}::uuid AND target_table = 'expense_cache'
          AND target_id = ${expense!.id}::uuid
      `,
    );
    expect(audit?.old_key).toBe(oldReceipt);
  });

  test("a bucket failure still deletes the row and keeps the bytes counted", async () => {
    const tenant = await newTenant();
    const assignmentId = await createAssignment(tenant, "draft");
    const { attachmentId, permanentKey } = await attachToAssignment(tenant, assignmentId, 700);

    storage.failRemove = true;
    try {
      const res = await request(
        tenant,
        teacher(tenant),
        "DELETE",
        `/api/academics/assignments/${assignmentId}/attachments/${attachmentId}`,
      );
      expect(res.status).toBe(204);
    } finally {
      storage.failRemove = false;
    }
    expect(storage.objects.has(permanentKey)).toBe(true);
    expect(await meter(tenant.schoolId)).toBe(700);
    const [row] = await asAdmin(
      tenant.schoolId,
      (tx) => tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM app.assignment_attachments WHERE id = ${attachmentId}
      `,
    );
    expect(row!.n).toBe(0);
  });
});

describeDb("app.referenced_storage_keys lists every storage-key column", () => {
  test("every key-holding column is checked by the function", async () => {
    // Any text column named like a stored-object key. A new one fails here until it is added to
    // 000204's function (or listed below with the reason it never holds a school's object).
    const columns = await database!.sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND data_type = 'text'
        AND column_name ~ '(^|_)(storage|object|thumbnail|preview|receipt_storage|proof_storage)_key$'
        AND table_name !~ '_y[0-9]{4}m[0-9]{2}$'
    `;
    const notSchoolObjects = new Set([
      // Global sign-up applications: permanent/school-applications/, never under a school.
      "school_applications.proof_storage_key",
    ]);
    const [definition] = await database!.sql<{ source: string }[]>`
      SELECT pg_get_functiondef('app.referenced_storage_keys(text[])'::regprocedure) AS source
    `;
    const missing = columns
      .map((column) => `${column.table_name}.${column.column_name}`)
      .filter((name) => !notSchoolObjects.has(name))
      .filter((name) => {
        const [table, column] = name.split(".");
        return !(
          definition!.source.includes(`app.${table} AS t`) &&
          definition!.source.includes(`t.${column} = w.key`)
        );
      });
    expect(columns.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  test("answers only for the current school", async () => {
    const first = await newTenant();
    const second = await newTenant();
    const assignmentId = await createAssignment(first, "draft");
    const { permanentKey } = await attachToAssignment(first, assignmentId, 10);

    const lookup = (schoolId: string) =>
      database!.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
        await tx.unsafe("SET LOCAL ROLE studafy_app");
        return tx<{ key: string }[]>`
          SELECT app.referenced_storage_keys(${[permanentKey, "permanent/x/y/z"]}::text[]) AS key
        `;
      });
    expect((await lookup(first.schoolId)).map((row) => row.key)).toEqual([permanentKey]);
    expect((await lookup(second.schoolId)).map((row) => row.key)).toEqual([]);
  });
});
