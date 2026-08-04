/**
 * Material malware scan (file-scan queue) tests.
 *
 * `quarantineKeyOf` is pure and always runs. Everything that proves the actual guarantee — clean
 * becomes `ready`, an infected object is copied to `quarantine/`, the served copy is deleted, the
 * uploader is notified exactly once, and a scan error fails closed — needs a real database, real
 * migrations and a TCP clamd, so those follow the packages/db tests convention: skip unless
 * TEST_DATABASE_URL is set, assert against real rows. The S3 side is an in-memory fake behind the
 * worker's `ScanS3Client` interface; the acceptance criteria (infected bytes never served) is
 * asserted on that fake's object map.
 */

import { randomUUID } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  materialScanFailedListener,
  processMaterialScan,
  quarantineKeyOf,
} from "./scan-material.worker";
import { startFakeClamd, startSilentServer } from "./test-clamd-server";

import type { ScanS3Client } from "./s3";
import type { Job } from "bullmq";
import type { Sql } from "postgres";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("quarantineKeyOf", () => {
  test("maps a permanent key to the quarantine prefix", () => {
    expect(quarantineKeyOf("permanent/abc/materials/notes.pdf")).toBe(
      "quarantine/abc/materials/notes.pdf",
    );
  });

  test("rejects keys not under permanent/", () => {
    expect(quarantineKeyOf("temp/abc/x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// In-memory S3 fake
// ---------------------------------------------------------------------------

function notFound(): Error {
  return Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } });
}

interface FakeS3 {
  client: ScanS3Client;
  objects: Map<string, Buffer>;
}

function createFakeS3(): FakeS3 {
  const objects = new Map<string, Buffer>();
  const client: ScanS3Client = {
    async getObject({ Key }) {
      const bytes = objects.get(Key);
      if (!bytes) throw notFound();
      return {
        Body: (async function* () {
          yield bytes;
        })(),
      };
    },
    async headObject({ Key }) {
      return { exists: objects.has(Key) };
    },
    async copyObject({ Bucket, Key, CopySource }) {
      const sourceKey = CopySource.slice(Bucket.length + 1);
      const bytes = objects.get(sourceKey);
      if (!bytes) throw notFound();
      objects.set(Key, Buffer.from(bytes));
    },
    async deleteObject({ Key }) {
      objects.delete(Key);
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
  classId: string;
  uploaderUserId: string;
  storageKey: string;
}

let fixtureSeq = 0;

/**
 * A school with one class and one material already in `scanning`. Seeded as studafy_admin the way
 * apps/api/tests/harness/factories.ts does — role_scope_visibility gates INSERT ... RETURNING.
 */
async function seedFixture(): Promise<MaterialFixture> {
  fixtureSeq += 1;
  const tag = `scan${fixtureSeq}-${Date.now().toString(36)}`;

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
      VALUES (${tag}, ${`Scan ${tag}`}, ${schoolEmail}, ${schoolEmail},
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
    const classId = cls!.id;

    const storageKey = `permanent/${schoolId}/materials/scan-test.txt`;
    const [material] = await tx<{ id: string }[]>`
      INSERT INTO app.materials
        (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title,
         storage_key, original_file_name, mime_type, size_bytes, ingest_status)
      VALUES (${schoolId}::uuid, ${classId}::uuid, ${uploaderUserId}::uuid, ${uploaderUserId}::uuid,
              ${`Material ${tag}`}, ${storageKey}, 'scan-test.txt', 'text/plain', 1024,
              'scanning'::app.material_ingest_status)
      RETURNING id
    `;

    return { schoolId, materialId: material!.id, classId, uploaderUserId, storageKey };
  });
}

const jobFor = (f: MaterialFixture, id = randomUUID()): Job =>
  ({
    id,
    name: "scan-material",
    data: {
      schoolId: f.schoolId,
      materialId: f.materialId,
      storageKey: f.storageKey,
      uploadedByUserId: f.uploaderUserId,
    },
  }) as unknown as Job;

async function materialRow(f: MaterialFixture) {
  const [row] = await sql<
    {
      ingest_status: string;
      ingest_error: string | null;
      ingested_at: Date | null;
    }[]
  >`
    SELECT ingest_status::text AS ingest_status, ingest_error, ingested_at
    FROM app.materials WHERE id = ${f.materialId}::uuid
  `;
  return row;
}

async function scanNotifications(f: MaterialFixture) {
  const rows = await sql<{ notification_type: string; metadata: unknown }[]>`
    SELECT notification_type::text AS notification_type, metadata
    FROM app.notifications WHERE school_id = ${f.schoolId}::uuid
    ORDER BY created_at
  `;
  return rows;
}

async function scanOutboxEvents(f: MaterialFixture) {
  const rows = await sql<{ event_name: string; payload: unknown }[]>`
    SELECT event_name, payload FROM app.outbox_events WHERE school_id = ${f.schoolId}::uuid
    ORDER BY created_at
  `;
  return rows;
}

describeDb("processMaterialScan", () => {
  test("a clean verdict flips the material to ready and leaves the permanent object", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(f.storageKey, Buffer.from("harmless notes for the class"));

    const clamd = await startFakeClamd(() => "stream: OK");
    try {
      const result = await processMaterialScan(jobFor(f), {
        databaseUrl: databaseUrl!,
        s3: s3.client,
        bucket: "test-bucket",
        clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000, maxFileBytes: 1 << 20 },
      });

      expect(result).toEqual({ processed: true, outcome: "clean" });
      const row = await materialRow(f);
      expect(row!.ingest_status).toBe("ready");
      expect(row!.ingest_error).toBeNull();
      expect(row!.ingested_at).not.toBeNull();
      expect(s3.objects.has(f.storageKey)).toBe(true);
      expect(await scanNotifications(f)).toHaveLength(0);
      expect(await scanOutboxEvents(f)).toHaveLength(0);
    } finally {
      await clamd.close();
    }
  });

  test("an infected verdict quarantines the object, notifies, and removes the served copy", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    s3.objects.set(f.storageKey, Buffer.from(eicar));

    const quarantineKey = quarantineKeyOf(f.storageKey)!;

    const clamd = await startFakeClamd(() => "stream: Win.Test.EICAR_HDB-1 FOUND");
    try {
      const result = await processMaterialScan(jobFor(f), {
        databaseUrl: databaseUrl!,
        s3: s3.client,
        bucket: "test-bucket",
        clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000, maxFileBytes: 1 << 20 },
      });

      expect(result).toEqual({ processed: true, outcome: "quarantined" });
      const row = await materialRow(f);
      expect(row!.ingest_status).toBe("quarantined");
      expect(row!.ingest_error).toContain("Win.Test.EICAR_HDB-1");
      expect(row!.ingested_at).toBeNull();

      // The infected bytes exist only under quarantine/ — the served copy is gone.
      expect(s3.objects.has(quarantineKey)).toBe(true);
      expect(s3.objects.get(quarantineKey)!.toString("utf8")).toBe(eicar);
      expect(s3.objects.has(f.storageKey)).toBe(false);

      const notifications = await scanNotifications(f);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.notification_type).toBe("MATERIAL_SCAN_QUARANTINED");
      expect((notifications[0]!.metadata as { material_id?: string }).material_id).toBe(
        f.materialId,
      );

      const events = await scanOutboxEvents(f);
      expect(events).toHaveLength(1);
      expect(events[0]!.event_name).toBe("material.quarantined");
      expect(events[0]!.payload).toEqual({
        materialId: f.materialId,
        schoolId: f.schoolId,
        virus: "Win.Test.EICAR_HDB-1",
      });
    } finally {
      await clamd.close();
    }
  });

  test("re-scans the quarantine copy when a prior run died after deleting the permanent object", async () => {
    // Simulates the crash window: copy happened, delete happened, the flip never committed. The
    // retry must find the object missing under permanent/ but present under quarantine/ and reach
    // the same verdict.
    const f = await seedFixture();
    const s3 = createFakeS3();
    const quarantineKey = quarantineKeyOf(f.storageKey)!;
    s3.objects.set(quarantineKey, Buffer.from("still infected bytes"));

    const clamd = await startFakeClamd(() => "stream: Win.Test.EICAR_HDB-1 FOUND");
    try {
      const result = await processMaterialScan(jobFor(f), {
        databaseUrl: databaseUrl!,
        s3: s3.client,
        bucket: "test-bucket",
        clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000, maxFileBytes: 1 << 20 },
      });

      expect(result).toEqual({ processed: true, outcome: "quarantined" });
      const row = await materialRow(f);
      expect(row!.ingest_status).toBe("quarantined");
      // Idempotent copy + delete: the quarantine copy is still the only one.
      expect(s3.objects.has(quarantineKey)).toBe(true);
      expect(s3.objects.has(f.storageKey)).toBe(false);
    } finally {
      await clamd.close();
    }
  });

  test("skips a material that is no longer scanning", async () => {
    const f = await seedFixture();
    await sql`
      UPDATE app.materials SET ingest_status = 'ready'::app.material_ingest_status,
        ingested_at = CURRENT_TIMESTAMP
      WHERE id = ${f.materialId}::uuid
    `;
    const s3 = createFakeS3();
    s3.objects.set(f.storageKey, Buffer.from("already served"));

    const clamd = await startFakeClamd(() => "stream: OK");
    try {
      const result = await processMaterialScan(jobFor(f), {
        databaseUrl: databaseUrl!,
        s3: s3.client,
        bucket: "test-bucket",
        clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000, maxFileBytes: 1 << 20 },
      });

      expect(result).toEqual({ processed: true, outcome: "skipped" });
      const row = await materialRow(f);
      expect(row!.ingest_status).toBe("ready");
      expect(s3.objects.has(f.storageKey)).toBe(true);
      expect(await scanNotifications(f)).toHaveLength(0);
    } finally {
      await clamd.close();
    }
  });

  test("a missing object with no quarantine copy fails closed", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3(); // empty

    const clamd = await startFakeClamd(() => "stream: OK");
    try {
      await expect(
        processMaterialScan(jobFor(f), {
          databaseUrl: databaseUrl!,
          s3: s3.client,
          bucket: "test-bucket",
          clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000, maxFileBytes: 1 << 20 },
        }),
      ).rejects.toThrow(/no quarantine copy/);
    } finally {
      await clamd.close();
    }
  });

  test("a clamd scan error throws rather than fabricating a clean verdict", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(f.storageKey, Buffer.from("bytes clamd refuses"));

    const clamd = await startFakeClamd(() => "stream: ERROR");
    try {
      await expect(
        processMaterialScan(jobFor(f), {
          databaseUrl: databaseUrl!,
          s3: s3.client,
          bucket: "test-bucket",
          clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000, maxFileBytes: 1 << 20 },
        }),
      ).rejects.toThrow(/clamd scan failed/);
    } finally {
      await clamd.close();
    }
  });

  test("a clamd timeout throws", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(f.storageKey, Buffer.from("stuck bytes"));

    const silent = await startSilentServer();
    try {
      await expect(
        processMaterialScan(jobFor(f), {
          databaseUrl: databaseUrl!,
          s3: s3.client,
          bucket: "test-bucket",
          clamd: { host: "127.0.0.1", port: silent.port, timeoutMs: 200, maxFileBytes: 1 << 20 },
        }),
      ).rejects.toThrow(/clamd timed out/);
    } finally {
      await silent.close();
    }
  });
});

describeDb("materialScanFailedListener", () => {
  const log = {
    warn: () => undefined,
    error: () => undefined,
  };

  async function waitForScanState(f: MaterialFixture, expected: string): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      const row = await materialRow(f);
      if (row?.ingest_status === expected) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`material did not reach ${expected}`);
  }

  test("a terminal failure marks the material failed and alerts the uploader", async () => {
    const f = await seedFixture();

    const listener = materialScanFailedListener(databaseUrl!, log);
    listener(
      {
        id: "job-1",
        name: "scan-material",
        data: {
          schoolId: f.schoolId,
          materialId: f.materialId,
          storageKey: f.storageKey,
          uploadedByUserId: f.uploaderUserId,
        },
        attemptsMade: 3,
        finishedOn: Date.now(),
        stacktrace: [],
      },
      new Error("clamd scan failed: stream: ERROR"),
    );

    await waitForScanState(f, "failed");

    const row = await materialRow(f);
    expect(row!.ingest_error).toBe("Malware scan failed");
    expect(row!.ingested_at).toBeNull();

    const notifications = await scanNotifications(f);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.notification_type).toBe("MATERIAL_SCAN_FAILED");
  });

  test("a non-terminal failure is ignored", async () => {
    const f = await seedFixture();

    const listener = materialScanFailedListener(databaseUrl!, log);
    listener(
      {
        id: "job-2",
        name: "scan-material",
        data: {
          schoolId: f.schoolId,
          materialId: f.materialId,
          storageKey: f.storageKey,
          uploadedByUserId: f.uploaderUserId,
        },
        attemptsMade: 1,
        stacktrace: [],
      },
      new Error("transient"),
    );

    // Give the (should-be-no-op) handler time to run if it were going to.
    await new Promise((r) => setTimeout(r, 100));

    const row = await materialRow(f);
    expect(row!.ingest_status).toBe("scanning");
    expect(await scanNotifications(f)).toHaveLength(0);
  });
});
