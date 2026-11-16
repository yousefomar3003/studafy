/**
 * The material pipeline as teachers, students and parents see it, over HTTP.
 *
 *  - Students and parents see only `ready` materials, in the list, by id and in global search. A
 *    material still being uploaded, scanned or processed, or one that failed or was blocked, is the
 *    teacher's business.
 *  - Turning a material's AI use off keeps it downloadable; turning it back on re-queues ingestion.
 *  - A teacher retries a failed material (POST /retry): it goes back to scanning, audited.
 *  - Re-uploading a file whose earlier attempt failed replaces that attempt and frees its file.
 *  - Starting an upload wakes the scaled-to-zero scanner, without ever affecting the request.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/academics/material-pipeline-http.test.ts
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

function fakeStorage(): StorageService & { objects: Map<string, number> } {
  const objects = new Map<string, number>();
  return {
    objects,
    ttlSeconds: 900,
    check: async () => true,
    presign: (key, _method, _contentType, ttl) => ({
      url: `https://storage.example/${key}?signed`,
      expiresAt: new Date(Date.now() + (ttl ?? 900) * 1000),
    }),
    exists: async (key) => objects.has(key),
    size: async (key) => objects.get(key) ?? 0,
    head: async (key) => {
      const sizeBytes = objects.get(key);
      return sizeBytes === undefined ? null : { contentType: "application/pdf", sizeBytes };
    },
    checksumSha256: async () => "a".repeat(64),
    copy: async (source, destination) => {
      const sizeBytes = objects.get(source);
      if (sizeBytes !== undefined) objects.set(destination, sizeBytes);
    },
    remove: async (key) => {
      objects.delete(key);
    },
    async *list(prefix) {
      for (const [key, sizeBytes] of objects) {
        if (key.startsWith(prefix)) yield { key, sizeBytes };
      }
    },
  };
}

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
const storage = fakeStorage();
let warmups = 0;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({
    database: database.sql,
    storage,
    uploadScanEnqueuer: async () => undefined,
    scannerWarmup: () => {
      warmups += 1;
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

type Status =
  "uploaded" | "scanning" | "queued" | "processing" | "ready" | "failed" | "quarantined";
const ALL_STATUSES: Status[] = [
  "uploaded",
  "scanning",
  "queued",
  "processing",
  "ready",
  "failed",
  "quarantined",
];

interface Actor {
  userId: string;
  roles: Role[];
}

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

function request(tenant: TenantFixture, as: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { schoolId: tenant.schoolId, userId: as.userId, roles: as.roles, channel: "mobile" },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

interface Tenant {
  tenant: TenantFixture;
  teacher: Actor;
  student: Actor;
  parent: Actor;
  /** Material id by status. */
  materials: Record<Status, string>;
}

/** One class with one material in every pipeline state, a teacher, an enrolled student, a parent. */
async function newTenant(): Promise<Tenant> {
  const tenant = await createFullTenant(database!.sql);
  const teacher = { userId: tenant.teachers[0]!.userId, roles: [ROLES.INSTRUCTOR] };
  await assignRole(database!.sql, tenant.schoolId, teacher.userId, ROLES.INSTRUCTOR);
  const student = { userId: tenant.students[0]!.userId, roles: [ROLES.STUDENT] };
  await assignRole(database!.sql, tenant.schoolId, student.userId, ROLES.STUDENT);
  const parent = { userId: tenant.users.PARENT.id, roles: [ROLES.PARENT] };

  const materials = {} as Record<Status, string>;
  await asAdmin(tenant.schoolId, async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}, 'Test Family', ${parent.userId}) RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship, family_id)
      VALUES (${tenant.schoolId}, ${parent.userId}, ${tenant.students[0]!.id}, 'guardian', ${family!.id})
    `;
    for (const status of ALL_STATUSES) {
      materials[status] = await insertMaterial(tx, tenant, teacher.userId, status);
    }
  });
  return { tenant, teacher, student, parent, materials };
}

async function insertMaterial(
  tx: TestDatabase["sql"],
  tenant: TenantFixture,
  uploaderId: string,
  status: Status,
  options: { fileName?: string; key?: string; createdAt?: string } = {},
): Promise<string> {
  const key =
    options.key ?? `permanent/${tenant.schoolId}/materials/${crypto.randomUUID()}-${status}.pdf`;
  const error = status === "failed" || status === "quarantined" ? `${status} for test` : null;
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.materials (
      school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, storage_key,
      original_file_name, mime_type, size_bytes, ingest_status, ingest_error, ingested_at
    ) VALUES (
      ${tenant.schoolId}, ${tenant.cls.id}, ${uploaderId}, ${uploaderId}, ${`Notes ${status}`},
      ${key}, ${options.fileName ?? `${status}.pdf`}, 'application/pdf', 1000,
      ${status}::app.material_ingest_status, ${error},
      ${status === "ready" ? new Date() : null}
    )
    RETURNING id
  `;
  return row!.id;
}

async function listStatuses(t: Tenant, as: Actor): Promise<string[]> {
  const res = await request(
    t.tenant,
    as,
    "GET",
    `/api/academics/materials?class_id=${t.tenant.cls.id}&limit=100`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { materials: { ingest_status: string }[]; total: number };
  expect(body.total).toBe(body.materials.length);
  return body.materials.map((m) => m.ingest_status).sort();
}

// ---------------------------------------------------------------------------
// B. Students and parents see only ready materials
// ---------------------------------------------------------------------------

describeDb("who sees which materials", () => {
  test("the teacher sees every state; the student and the parent see only ready", async () => {
    const t = await newTenant();

    expect(await listStatuses(t, t.teacher)).toEqual([...ALL_STATUSES].sort());
    expect(await listStatuses(t, t.student)).toEqual(["ready"]);
    expect(await listStatuses(t, t.parent)).toEqual(["ready"]);
  });

  test("a student asking for another state by filter gets nothing", async () => {
    const t = await newTenant();
    const res = await request(
      t.tenant,
      t.student,
      "GET",
      `/api/academics/materials?class_id=${t.tenant.cls.id}&ingest_status=failed`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ materials: [], total: 0 });
  });

  test("by id, an unfinished or failed material is not found for a student", async () => {
    const t = await newTenant();
    for (const status of ALL_STATUSES) {
      const path = `/api/academics/materials/${t.materials[status]}`;
      const asStudent = await request(t.tenant, t.student, "GET", path);
      expect({ status, code: asStudent.status }).toEqual({
        status,
        code: status === "ready" ? 200 : 404,
      });
      const asTeacher = await request(t.tenant, t.teacher, "GET", path);
      expect({ status, code: asTeacher.status }).toEqual({ status, code: 200 });
    }
  });
});

describeDb("global search over materials", () => {
  async function searchStatuses(t: Tenant, as: Actor): Promise<string[]> {
    const res = await request(t.tenant, as, "GET", "/api/search?q=Notes&types=materials&limit=20");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { materials: { ingest_status: string }[] };
      totals: { materials: number };
    };
    expect(body.totals.materials).toBe(body.results.materials.length);
    return body.results.materials.map((m) => m.ingest_status).sort();
  }

  test("finds every state for the teacher and only ready for the student", async () => {
    const t = await newTenant();

    expect(await searchStatuses(t, t.teacher)).toEqual([...ALL_STATUSES].sort());
    expect(await searchStatuses(t, t.student)).toEqual(["ready"]);
  });
});

describeDb("turning a material's AI use off and on", () => {
  test("keeps it downloadable for students, and turning AI back on re-queues it", async () => {
    const t = await newTenant();
    const id = t.materials.ready;
    const path = `/api/academics/materials/${id}/ai-visible`;
    const download = () =>
      request(t.tenant, t.student, "GET", `/api/storage/downloads/material/${id}`);
    expect((await download()).status).toBe(200);

    const off = await request(t.tenant, t.teacher, "PATCH", path, { ai_visible: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { ingest_status: string }).ingest_status).toBe("ready");
    expect((await download()).status).toBe(200);
    expect(await listStatuses(t, t.student)).toEqual(["ready"]);

    const on = await request(t.tenant, t.teacher, "PATCH", path, { ai_visible: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { ingest_status: string }).ingest_status).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// C. Failed attempts don't linger
// ---------------------------------------------------------------------------

describeDb("retrying a failed material", () => {
  test("puts it back to scanning, clears the error and audits it", async () => {
    const t = await newTenant();
    const id = t.materials.failed;
    const [row] = await asAdmin(
      t.tenant.schoolId,
      (tx) => tx<{ storage_key: string }[]>`SELECT storage_key FROM app.materials WHERE id = ${id}`,
    );
    storage.objects.set(row!.storage_key, 1000);
    const before = warmups;

    const res = await request(t.tenant, t.teacher, "POST", `/api/academics/materials/${id}/retry`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ingest_status: string; ingest_error: string | null };
    expect(body.ingest_status).toBe("scanning");
    expect(body.ingest_error).toBeNull();
    expect(warmups).toBe(before + 1);
    const audits = await asAdmin(
      t.tenant.schoolId,
      (tx) => tx<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }[]>`
        SELECT old_values, new_values FROM app.audit_logs
        WHERE target_table = 'materials' AND target_id = ${id} AND action = 'update'
      `,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.old_values).toMatchObject({
      ingest_status: "failed",
      ingest_error: "failed for test",
    });
    expect(audits[0]!.new_values).toMatchObject({ ingest_status: "scanning", retried: true });

    // Now scanning: a second retry is refused.
    const again = await request(
      t.tenant,
      t.teacher,
      "POST",
      `/api/academics/materials/${id}/retry`,
    );
    expect(again.status).toBe(409);
  });

  test("is refused for anything that is not failed", async () => {
    const t = await newTenant();
    for (const status of ALL_STATUSES.filter((s) => s !== "failed")) {
      const res = await request(
        t.tenant,
        t.teacher,
        "POST",
        `/api/academics/materials/${t.materials[status]}/retry`,
      );
      expect({ status, code: res.status }).toEqual({ status, code: 409 });
    }
  });

  test("is refused when the file is gone from storage", async () => {
    const t = await newTenant();
    const res = await request(
      t.tenant,
      t.teacher,
      "POST",
      `/api/academics/materials/${t.materials.failed}/retry`,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("MATERIAL_STORAGE_CONFIRM_FAILED");
  });

  test("is staff work: a student is refused", async () => {
    const t = await newTenant();
    const res = await request(
      t.tenant,
      t.student,
      "POST",
      `/api/academics/materials/${t.materials.failed}/retry`,
    );
    expect(res.status).toBe(403);
  });
});

describeDb("uploading a file again after a failed attempt", () => {
  test("replaces the failed attempt and frees its file", async () => {
    const t = await newTenant();
    const fileName = `worksheet-${crypto.randomUUID().slice(0, 8)}.pdf`;
    const failedKey = `permanent/${t.tenant.schoolId}/materials/${crypto.randomUUID()}-worksheet.pdf`;
    const failedId = await asAdmin(t.tenant.schoolId, (tx) =>
      insertMaterial(tx, t.tenant, t.teacher.userId, "failed", { fileName, key: failedKey }),
    );
    storage.objects.set(failedKey, 1000);
    await asAdmin(t.tenant.schoolId, (tx) => tx`SELECT app.set_storage_usage(${1000})`);
    const before = warmups;

    const res = await request(t.tenant, t.teacher, "POST", "/api/academics/materials/upload", {
      class_id: t.tenant.cls.id,
      title: "Worksheet",
      original_file_name: fileName,
      mime_type: "application/pdf",
      size_bytes: 1000,
    });

    expect(res.status).toBe(201);
    expect(warmups).toBe(before + 1);
    const rows = await asAdmin(
      t.tenant.schoolId,
      (tx) => tx<{ id: string; ingest_status: string }[]>`
        SELECT id, ingest_status::text AS ingest_status FROM app.materials
        WHERE class_id = ${t.tenant.cls.id} AND original_file_name = ${fileName}
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(failedId);
    expect(rows[0]!.ingest_status).toBe("uploaded");
    expect(storage.objects.has(failedKey)).toBe(false);
    expect(await meter(t.tenant.schoolId)).toBe(0);
  });

  test("keeps another teacher's failed attempt and an old AI-off row in 'uploaded'", async () => {
    const t = await newTenant();
    const fileName = `slides-${crypto.randomUUID().slice(0, 8)}.pdf`;
    const otherTeacher = t.tenant.users.INSTRUCTOR.id;
    const othersKey = `permanent/${t.tenant.schoolId}/materials/${crypto.randomUUID()}-slides.pdf`;
    const ids = await asAdmin(t.tenant.schoolId, async (tx) => {
      const others = await insertMaterial(tx, t.tenant, otherTeacher, "failed", {
        fileName,
        key: othersKey,
      });
      // Turning AI off used to leave a confirmed material in 'uploaded' with ai_visible off; a row
      // like that which migration 000227 could not place may still be a real material.
      const aiOff = await insertMaterial(tx, t.tenant, t.teacher.userId, "uploaded", { fileName });
      await tx`UPDATE app.materials SET ai_visible = false WHERE id = ${aiOff}`;
      return [others, aiOff];
    });
    storage.objects.set(othersKey, 1000);

    const res = await request(t.tenant, t.teacher, "POST", "/api/academics/materials/upload", {
      class_id: t.tenant.cls.id,
      title: "Slides",
      original_file_name: fileName,
      mime_type: "application/pdf",
      size_bytes: 1000,
    });

    // The AI-off material is 'uploaded', which the in-progress guard counts, so the new upload is
    // refused as a duplicate rather than deleting it.
    expect(res.status).toBe(409);
    const left = await asAdmin(
      t.tenant.schoolId,
      (tx) => tx<{ id: string }[]>`
        SELECT id FROM app.materials WHERE id = ANY(${ids}::uuid[])
      `,
    );
    expect(left).toHaveLength(2);
    expect(storage.objects.has(othersKey)).toBe(true);
  });
});
