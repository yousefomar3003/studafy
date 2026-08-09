/**
 * Material thumbnail/preview derivation (derivations queue) tests.
 *
 * `thumbnailKeyOf`/`previewKeyOf` are pure and always run, and `deriveRaster`/`derivePdf` — the
 * actual @napi-rs/canvas + unpdf rasterizers — run against the committed ai-ingestion fixtures with
 * no database. Everything that proves the job's end-to-end guarantee (a `ready` material gets its
 * derived keys; unsupported/corrupt/missing content leaves them NULL and never fails the material;
 * the original object is never modified) needs a real database and real migrations, so those follow
 * the packages/db tests convention: skip unless TEST_DATABASE_URL is set, assert against real rows.
 * The S3 side is an in-memory fake behind the worker's `DerivationS3Client` interface, and
 * "originals untouched" is asserted on that fake's object map.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { loadImage } from "@napi-rs/canvas";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  derivePdf,
  deriveRaster,
  processMaterialDerivation,
  thumbnailKeyOf,
  previewKeyOf,
} from "./derivation.worker";

import type { MaterialDerivationConfig } from "./derivation.worker";
import type { DerivationS3Client } from "./s3";
import type { Job } from "bullmq";
import type { Sql } from "postgres";

const FIXTURE_DIR = join(import.meta.dir, "..", "ai-ingestion", "__fixtures__", "files");

async function fixtureBytes(file: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(join(FIXTURE_DIR, file)).bytes());
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("thumbnailKeyOf / previewKeyOf", () => {
  test("maps a material to its derived-image keys", () => {
    const schoolId = "11111111-1111-4111-8111-111111111111";
    const materialId = "22222222-2222-4222-8222-222222222222";
    expect(thumbnailKeyOf(schoolId, materialId)).toBe(
      `permanent/${schoolId}/${materialId}/thumbnail.jpg`,
    );
    expect(previewKeyOf(schoolId, materialId)).toBe(
      `permanent/${schoolId}/${materialId}/preview.jpg`,
    );
  });
});

// ---------------------------------------------------------------------------
// Rasterizers (no database)
// ---------------------------------------------------------------------------

describe("rasterizers", () => {
  test("deriveRaster fits a PNG into a 320px thumbnail", async () => {
    const { thumbnail } = await deriveRaster(await fixtureBytes("photosynthesis-notes.png"));
    const decoded = await loadImage(new Uint8Array(thumbnail));
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(320);
    expect(Math.min(decoded.width, decoded.height)).toBeGreaterThan(0);
  });

  test("derivePdf renders the first page into a thumbnail and a preview", async () => {
    const { thumbnail, preview } = await derivePdf(await fixtureBytes("photosynthesis-guide.pdf"));
    expect(preview).not.toBeNull();
    const thumb = await loadImage(new Uint8Array(thumbnail));
    const prev = await loadImage(new Uint8Array(preview!));
    expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(320);
    expect(Math.max(prev.width, prev.height)).toBeLessThanOrEqual(1280);
    expect(Math.min(thumb.width, thumb.height)).toBeGreaterThan(0);
  });

  test("derivePdf rejects a file that is not a PDF", async () => {
    await expect(derivePdf(Buffer.from("plain text pretending to be a pdf"))).rejects.toThrow(
      /not a valid PDF/,
    );
  });

  test("deriveRaster rejects bytes it cannot decode", async () => {
    await expect(deriveRaster(Buffer.from("not an image"))).rejects.toThrow(/could not be decoded/);
  });
});

// ---------------------------------------------------------------------------
// In-memory S3 fake
// ---------------------------------------------------------------------------

function notFound(): Error {
  return Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } });
}

interface FakeS3 {
  client: DerivationS3Client;
  objects: Map<string, Buffer>;
}

function createFakeS3(): FakeS3 {
  const objects = new Map<string, Buffer>();
  const client: DerivationS3Client = {
    async getObject({ Key }) {
      const bytes = objects.get(Key);
      if (!bytes) throw notFound();
      return {
        Body: (async function* () {
          yield bytes;
        })(),
      };
    },
    async putObject({ Key, Body }) {
      objects.set(Key, Buffer.from(Body));
    },
  };
  return { client, objects };
}

// ---------------------------------------------------------------------------
// Database integration
// ---------------------------------------------------------------------------

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let sql: Sql;

beforeAll(() => {
  if (!databaseUrl) return;
  sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, prepare: false });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

interface MaterialFixture {
  schoolId: string;
  materialId: string;
  storageKey: string;
}

let fixtureSeq = 0;

/**
 * A school with one class and one material seeded in the given ingest status. Seeded as
 * studafy_admin the way apps/api/tests/harness/factories.ts does — role_scope_visibility gates
 * INSERT ... RETURNING.
 */
async function seedFixture(options: {
  mimeType: string;
  fileName: string;
  status: string;
}): Promise<MaterialFixture> {
  fixtureSeq += 1;
  const tag = `derive${fixtureSeq}-${Date.now().toString(36)}`;

  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const schoolEmail = `${tag}@admin.local`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`Derive ${tag}`}, ${schoolEmail}, ${schoolEmail},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [uploader] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${`u-${tag}@t.local`}, ${`u-${tag}@t.local`}, 'Teacher', 'active')
      RETURNING id
    `;
    const uploaderUserId = uploader!.id;

    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${schoolId}::uuid, ${uploaderUserId}::uuid, ${`EMP-${tag}`}, 'active')
      RETURNING id
    `;
    const teacherId = teacher!.id;

    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${`AY-${tag}`}, ${`AY ${tag}`}, '2026-01-01'::date, '2026-12-31'::date, 'active')
      RETURNING id
    `;
    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${year!.id}::uuid, ${`T-${tag}`}, ${`T ${tag}`}, 1::smallint,
              '2026-01-01'::date, '2026-06-30'::date, 'active')
      RETURNING id
    `;
    const [subject] = await tx<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${schoolId}::uuid, ${`SUB-${tag}`}, ${`Subject ${tag}`}, 'active')
      RETURNING id
    `;
    const [course] = await tx<{ id: string }[]>`
      INSERT INTO app.courses (school_id, subject_id, code, name, credit_hours, status)
      VALUES (${schoolId}::uuid, ${subject!.id}::uuid, ${`CRS-${tag}`}, ${`Course ${tag}`}, 1, 'active')
      RETURNING id
    `;
    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${schoolId}::uuid, ${`RM-${tag}`}, ${`Room ${tag}`}, 'physical', 30, 'Main')
      RETURNING id
    `;
    const [cls] = await tx<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity, status)
      VALUES (${schoolId}::uuid, ${course!.id}::uuid, ${year!.id}::uuid, ${term!.id}::uuid,
              ${teacherId}::uuid, ${room!.id}::uuid, ${`CLS-${tag}`}, 32, 'active')
      RETURNING id
    `;

    const storageKey = `permanent/${schoolId}/materials/${options.fileName}`;
    const [material] = await tx<{ id: string }[]>`
      INSERT INTO app.materials
        (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title,
         storage_key, original_file_name, mime_type, size_bytes, ingest_status, ingested_at)
      VALUES (${schoolId}::uuid, ${cls!.id}::uuid, ${uploaderUserId}::uuid, ${uploaderUserId}::uuid,
              ${`Material ${tag}`}, ${storageKey}, ${options.fileName}, ${options.mimeType}, 1024,
              ${options.status}::app.material_ingest_status,
              ${options.status === "ready" ? new Date() : null})
      RETURNING id
    `;

    return { schoolId, materialId: material!.id, storageKey };
  });
}

const jobFor = (f: MaterialFixture, id = randomUUID()): Job =>
  ({
    id,
    name: "derive-material-previews",
    data: {
      schoolId: f.schoolId,
      materialId: f.materialId,
    },
  }) as unknown as Job;

const configFor = (s3: DerivationS3Client): MaterialDerivationConfig => ({
  databaseUrl: databaseUrl!,
  s3,
  bucket: "test-bucket",
});

async function deriveRow(f: MaterialFixture) {
  const [row] = await sql<
    { thumbnail_key: string | null; preview_key: string | null; ingest_status: string }[]
  >`
    SELECT thumbnail_key, preview_key, ingest_status::text AS ingest_status
    FROM app.materials WHERE id = ${f.materialId}::uuid
  `;
  return row;
}

describeDb("processMaterialDerivation", () => {
  test("derives a thumbnail for a PNG and records only the thumbnail key", async () => {
    const f = await seedFixture({
      mimeType: "image/png",
      fileName: "photosynthesis-notes.png",
      status: "ready",
    });
    const s3 = createFakeS3();
    s3.objects.set(f.storageKey, Buffer.from(await fixtureBytes("photosynthesis-notes.png")));

    const result = await processMaterialDerivation(jobFor(f), configFor(s3.client));

    expect(result).toEqual({ processed: true, outcome: "generated" });
    const row = await deriveRow(f);
    expect(row!.thumbnail_key).toBe(thumbnailKeyOf(f.schoolId, f.materialId));
    expect(row!.preview_key).toBeNull();
    expect(row!.ingest_status).toBe("ready");

    // The original was read but never modified; the derived thumbnail is a decodable ≤320px JPEG.
    expect(s3.objects.has(f.storageKey)).toBe(true);
    const thumb = s3.objects.get(row!.thumbnail_key!);
    expect(thumb).toBeDefined();
    const decoded = await loadImage(new Uint8Array(thumb!));
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(320);
  });

  test("derives a thumbnail and preview for a PDF", async () => {
    const f = await seedFixture({
      mimeType: "application/pdf",
      fileName: "photosynthesis-guide.pdf",
      status: "ready",
    });
    const s3 = createFakeS3();
    s3.objects.set(f.storageKey, Buffer.from(await fixtureBytes("photosynthesis-guide.pdf")));

    const result = await processMaterialDerivation(jobFor(f), configFor(s3.client));

    expect(result).toEqual({ processed: true, outcome: "generated" });
    const row = await deriveRow(f);
    expect(row!.thumbnail_key).toBe(thumbnailKeyOf(f.schoolId, f.materialId));
    expect(row!.preview_key).toBe(previewKeyOf(f.schoolId, f.materialId));

    const thumb = await loadImage(new Uint8Array(s3.objects.get(row!.thumbnail_key!)!));
    const prev = await loadImage(new Uint8Array(s3.objects.get(row!.preview_key!)!));
    expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(320);
    expect(Math.max(prev.width, prev.height)).toBeLessThanOrEqual(1280);
  });

  test("skips a material that is not ready", async () => {
    const f = await seedFixture({
      mimeType: "image/png",
      fileName: "pending.png",
      status: "scanning",
    });
    const s3 = createFakeS3();

    const result = await processMaterialDerivation(jobFor(f), configFor(s3.client));

    expect(result).toEqual({ processed: true, outcome: "skipped" });
    const row = await deriveRow(f);
    expect(row!.thumbnail_key).toBeNull();
    expect(row!.preview_key).toBeNull();
  });

  test("skips an unsupported type and never writes derived keys", async () => {
    const f = await seedFixture({
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      fileName: "photosynthesis-deck.pptx",
      status: "ready",
    });
    const s3 = createFakeS3();

    const result = await processMaterialDerivation(jobFor(f), configFor(s3.client));

    expect(result).toEqual({ processed: true, outcome: "skipped" });
    const row = await deriveRow(f);
    expect(row!.thumbnail_key).toBeNull();
    expect(row!.preview_key).toBeNull();
    expect(s3.objects.size).toBe(0);
  });

  test("skips corrupt PDF bytes instead of failing the material", async () => {
    const f = await seedFixture({
      mimeType: "application/pdf",
      fileName: "corrupt-not-a-pdf.pdf",
      status: "ready",
    });
    const s3 = createFakeS3();
    s3.objects.set(f.storageKey, Buffer.from(await fixtureBytes("corrupt-not-a-pdf.pdf")));

    const result = await processMaterialDerivation(jobFor(f), configFor(s3.client));

    expect(result).toEqual({ processed: true, outcome: "skipped" });
    const row = await deriveRow(f);
    expect(row!.thumbnail_key).toBeNull();
    expect(row!.preview_key).toBeNull();
    expect(row!.ingest_status).toBe("ready");
    expect(s3.objects.has(f.storageKey)).toBe(true);
  });

  test("skips when the source object is missing", async () => {
    const f = await seedFixture({
      mimeType: "image/png",
      fileName: "missing.png",
      status: "ready",
    });
    const s3 = createFakeS3();

    const result = await processMaterialDerivation(jobFor(f), configFor(s3.client));

    expect(result).toEqual({ processed: true, outcome: "skipped" });
    const row = await deriveRow(f);
    expect(row!.thumbnail_key).toBeNull();
    expect(row!.preview_key).toBeNull();
  });

  test("skips when a previous run already wrote the derived keys", async () => {
    const f = await seedFixture({
      mimeType: "image/png",
      fileName: "already.png",
      status: "ready",
    });
    const s3 = createFakeS3();
    s3.objects.set(f.storageKey, Buffer.from(await fixtureBytes("photosynthesis-notes.png")));
    await sql`
      UPDATE app.materials
      SET thumbnail_key = ${`permanent/${f.schoolId}/${f.materialId}/thumbnail.jpg`}
      WHERE id = ${f.materialId}::uuid
    `;

    const result = await processMaterialDerivation(jobFor(f), configFor(s3.client));

    expect(result).toEqual({ processed: true, outcome: "skipped" });
    const row = await deriveRow(f);
    expect(row!.thumbnail_key).toBe(`permanent/${f.schoolId}/${f.materialId}/thumbnail.jpg`);
    expect(row!.preview_key).toBeNull();
    // The duplicate job must not re-upload anything.
    expect(s3.objects.has(`permanent/${f.schoolId}/${f.materialId}/thumbnail.jpg`)).toBe(false);
  });

  test("invalid job data resolves to a skip without touching the database", async () => {
    const result = await processMaterialDerivation(
      { id: randomUUID(), name: "derive-material-previews", data: {} } as unknown as Job,
      configFor(createFakeS3().client),
    );
    expect(result).toEqual({ processed: false, reason: "invalid job data" });
  });
});
