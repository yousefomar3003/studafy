/**
 * QA-009: learning-material uploads go through the same staged pipeline as every other upload.
 *
 * Materials used to presign a PUT straight onto their permanent key, `permanent/{school}/materials/
 * {file name}`, valid for 15+ minutes. Once the virus scan marked the material ready, the same URL
 * could overwrite the scanned object with anything; students then downloaded it unscanned. Any MIME
 * type was accepted (text/html, image/svg+xml), with no size cap; quota was charged on the client's
 * claimed size; and the file-name key was unique school-wide, so two classes could not both upload
 * `worksheet.pdf`.
 *
 * Now: the PUT goes to `temp/{school}/{uuid}/{name}`, confirm checks the *stored* object against the
 * material.file content class and charges quota on its real size, then copies it to the row's own
 * `permanent/{school}/{uuid}/{name}`. A later PUT can only touch the abandoned temp object.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/academics/material-upload-pipeline.test.ts
 */

// Imported before src/middleware -- see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestApp, createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";
import { fakeStorage } from "../harness/fake-storage";
import { createSchoolUnderTest, tokenFor } from "../harness/object-access";

import type { TestApp, TestDatabase } from "../harness";
import type { SchoolUnderTest } from "../harness/object-access";

const describeDb = integrationEnabled ? describe : describe.skip;
const MIB = 1024 * 1024;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let a: SchoolUnderTest;
const storage = fakeStorage();

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  a = await createSchoolUnderTest(database.sql);
  const created = createTestApp({ database: database.sql, storage });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

async function call(method: string, path: string, body: unknown, actor = a.actors.teacherA) {
  const token = await tokenFor(harness!.keyStore, a.schoolId, actor);
  const response = await harness!.app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function initiate(fileName: string, extra: Record<string, unknown> = {}, classId = a.classX) {
  return call("POST", "/api/academics/materials/upload", {
    class_id: classId,
    title: `Material ${fileName}`,
    original_file_name: fileName,
    mime_type: "application/pdf",
    size_bytes: 1024,
    ...extra,
  });
}

async function materialRow(storageKeyLike: string) {
  const [row] = await database!.sql<{ id: string; storage_key: string; ingest_status: string }[]>`
    SELECT id, storage_key, ingest_status::text FROM app.materials
    WHERE storage_key LIKE ${storageKeyLike}
  `;
  return row;
}

describeDb("material upload pipeline (QA-009)", () => {
  test("the presigned PUT targets temp/, and the row names a per-upload permanent key", async () => {
    const started = await initiate("chapter-1.pdf");
    expect(started.status).toBe(201);
    const tempKey = started.body.storage_key as string;
    expect(tempKey.startsWith(`temp/${a.schoolId}/`)).toBe(true);
    expect(String(started.body.upload_url)).toContain(tempKey);

    const objectId = tempKey.split("/")[2]!;
    const row = await materialRow(`permanent/${a.schoolId}/${objectId}/%`);
    expect(row?.storage_key).toBe(`permanent/${a.schoolId}/${objectId}/chapter-1.pdf`);
  });

  test("confirm promotes the stored object, and a later PUT cannot replace what is served", async () => {
    const started = await initiate("lesson-plan.pdf");
    const tempKey = started.body.storage_key as string;
    storage.objects.set(tempKey, { contentType: "application/pdf", sizeBytes: 2048 });

    const materialId = (await materialRow(`%/${tempKey.split("/")[2]}/%`))!.id;
    const confirmed = await call("POST", `/api/academics/materials/${materialId}/confirm`, {
      storage_key: tempKey,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.ingest_status).toBe("scanning");
    const permanentKey = confirmed.body.storage_key as string;
    expect(storage.objects.get(permanentKey)).toEqual({
      contentType: "application/pdf",
      sizeBytes: 2048,
    });

    // The attacker's re-PUT after the scan: it can only land on the temp key.
    storage.objects.set(tempKey, { contentType: "application/pdf", sizeBytes: 66_000_000 });
    expect(storage.objects.get(permanentKey)).toEqual({
      contentType: "application/pdf",
      sizeBytes: 2048,
    });
  });

  test("types outside the material allowlist are refused (HTML, SVG)", async () => {
    for (const mime of ["text/html", "image/svg+xml", "application/javascript"]) {
      const started = await initiate(`x-${crypto.randomUUID()}.bin`, { mime_type: mime });
      expect(`${mime} -> ${started.status}`).toBe(`${mime} -> 400`);
    }
  });

  test("a claimed size over the material cap is refused", async () => {
    const started = await initiate("huge.pdf", { size_bytes: 101 * MIB });
    expect(started.status).toBe(400);
  });

  test("confirm judges the stored object, not the claim: a 200 MiB upload behind a 1 KiB claim is refused", async () => {
    const started = await initiate("small-claim.pdf");
    const tempKey = started.body.storage_key as string;
    storage.objects.set(tempKey, { contentType: "application/pdf", sizeBytes: 200 * MIB });
    const materialId = (await materialRow(`%/${tempKey.split("/")[2]}/%`))!.id;

    const confirmed = await call("POST", `/api/academics/materials/${materialId}/confirm`, {
      storage_key: tempKey,
    });
    expect(confirmed.status).toBe(400);
    expect(
      [...storage.objects.keys()].some(
        (k) => k.startsWith(`permanent/`) && k.includes(tempKey.split("/")[2]!),
      ),
    ).toBe(false);
  });

  test("two classes can each upload a file with the same name", async () => {
    const x = await initiate("worksheet.pdf", {}, a.classX);
    const y = await call(
      "POST",
      "/api/academics/materials/upload",
      {
        class_id: a.classY,
        title: "Worksheet",
        original_file_name: "worksheet.pdf",
        mime_type: "application/pdf",
        size_bytes: 1024,
      },
      a.actors.teacherB,
    );
    expect([x.status, y.status]).toEqual([201, 201]);
  });
});
