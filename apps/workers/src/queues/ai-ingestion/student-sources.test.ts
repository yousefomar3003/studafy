/**
 * Students' own AI sources (000232) through the workers: scan -> ingest, retention and erasure.
 *
 *   - a student's own photo goes through the same malware scan and OCR ingestion as a teacher's
 *     material, ends `ready` with its text, and its chunks are stamped with their owner (the column
 *     the RLS policy hides them by). Unlike a class material it gets no thumbnail, raises no
 *     notification and announces nothing to a class; an infected one is blocked just the same;
 *   - an assignment source is read from the assignment's own text and the teacher's attached files,
 *     in place: each file under its own heading, a file the pipeline cannot read skipped;
 *   - a student's own source is deleted, file and all, when its retention period ends, and when the
 *     student's data is erased.
 *
 * Requires a live, migrated PostgreSQL (TEST_DATABASE_URL), like the other worker DB suites.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/queues/ai-ingestion/student-sources.test.ts
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  PERSONAL_SOURCE_RETENTION_DAYS,
  purgeAbandonedMaterials,
} from "../maintenance/abandoned-material-sweep";
import { erasePersonalAiSources } from "../maintenance/authored-content-dsr";
import { processMaterialScan } from "../scan/scan-material.worker";
import { startFakeClamd } from "../scan/test-clamd-server";

import { buildDocx } from "./__fixtures__/generate";
import { processIngestJob } from "./worker";

import type { ScanS3Client } from "../scan/s3";
import type { Job } from "bullmq";
import type { Sql, TransactionSql } from "postgres";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

const readFixture = async (file: string): Promise<Uint8Array> =>
  Bun.file(join(import.meta.dir, "__fixtures__", "files", file)).bytes();

function fakeS3(): { client: ScanS3Client; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const missing = () =>
    Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } });
  return {
    objects,
    client: {
      async getObject({ Key }) {
        const bytes = objects.get(Key);
        if (!bytes) throw missing();
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
        const bytes = objects.get(CopySource.slice(Bucket.length + 1));
        if (!bytes) throw missing();
        objects.set(Key, Buffer.from(bytes));
      },
      async deleteObject({ Key }) {
        objects.delete(Key);
      },
    },
  };
}

interface School {
  schoolId: string;
  classId: string;
  teacherUserId: string;
  studentUserId: string;
  studentId: string;
}

let seq = 0;

async function asSystem<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    return fn(tx);
  })) as T;
}

/** A school with one class, its teacher, and one enrolled student. */
async function seedSchool(): Promise<School> {
  seq += 1;
  const tag = `aisrc${seq}-${Date.now().toString(36)}`;
  return (await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
             (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`School ${tag}`}, ${`${tag}@admin.local`}, ${`${tag}@admin.local`},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const user = async (name: string) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${`${name}-${tag}@t.local`}, ${`${name}-${tag}@t.local`},
                ${name}, 'active')
        RETURNING id
      `;
      return row!.id;
    };
    const teacherUserId = await user("teacher");
    const studentUserId = await user("student");
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${schoolId}::uuid, ${teacherUserId}::uuid, ${`EMP-${tag}`}, 'active')
      RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${studentUserId}::uuid, ${`ADM-${tag}`}, 'Sara', 'Student',
              'enrolled')
      RETURNING id
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${`AY-${tag}`}, ${`AY ${tag}`}, '2026-01-01', '2026-12-31', 'active')
      RETURNING id
    `;
    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${year!.id}::uuid, ${`T-${tag}`}, ${`T ${tag}`}, 1::smallint,
              '2026-01-01', '2026-06-30', 'active')
      RETURNING id
    `;
    const [subject] = await tx<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${schoolId}::uuid, ${`SUB-${tag}`}, ${`Subject ${tag}`}, 'active')
      RETURNING id
    `;
    const [course] = await tx<{ id: string }[]>`
      INSERT INTO app.courses (school_id, subject_id, code, name, credit_hours, status)
      VALUES (${schoolId}::uuid, ${subject!.id}::uuid, ${`CRS-${tag}`}, ${`Course ${tag}`}, 1,
              'active')
      RETURNING id
    `;
    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${schoolId}::uuid, ${`RM-${tag}`}, ${`Room ${tag}`}, 'physical', 30, 'Main')
      RETURNING id
    `;
    const [cls] = await tx<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity,
         status)
      VALUES (${schoolId}::uuid, ${course!.id}::uuid, ${year!.id}::uuid, ${term!.id}::uuid,
              ${teacher!.id}::uuid, ${room!.id}::uuid, ${`CLS-${tag}`}, 32, 'active')
      RETURNING id
    `;
    await tx`
      INSERT INTO app.enrollments (school_id, class_id, student_id)
      VALUES (${schoolId}::uuid, ${cls!.id}::uuid, ${student!.id}::uuid)
    `;
    return {
      schoolId,
      classId: cls!.id,
      teacherUserId,
      studentUserId,
      studentId: student!.id,
    };
  })) as School;
}

/** A student's own upload, confirmed: in `scanning`, as the API's confirm leaves it. */
async function seedPersonalSource(
  school: School,
  options: { mimeType?: string; fileName?: string; createdAt?: Date } = {},
): Promise<{ id: string; storageKey: string }> {
  const fileName = options.fileName ?? "notes.png";
  const storageKey = `permanent/${school.schoolId}/ai-sources/${randomUUID()}-${fileName}`;
  const [row] = await asSystem(
    school.schoolId,
    (tx) => tx<{ id: string }[]>`
      INSERT INTO app.materials (
        school_id, class_id, source_kind, owner_student_id, uploaded_by_user_id,
        last_edited_by_user_id, title, storage_key, original_file_name, mime_type, size_bytes,
        ai_visible, ingest_status, created_at, updated_at
      ) VALUES (
        ${school.schoolId}::uuid, NULL, 'personal', ${school.studentId}::uuid,
        ${school.studentUserId}::uuid, ${school.studentUserId}::uuid, 'My notes', ${storageKey},
        ${fileName}, ${options.mimeType ?? "image/png"}, 2048, true,
        'scanning'::app.material_ingest_status,
        ${options.createdAt ?? new Date()}, ${options.createdAt ?? new Date()}
      )
      RETURNING id
    `,
  );
  return { id: row!.id, storageKey };
}

const ingestJob = (schoolId: string, materialId: string): Job =>
  ({
    id: randomUUID(),
    name: "ai-ingestion",
    data: { version: 1, schoolId, materialId },
    attemptsMade: 0,
    opts: { attempts: 1 },
  }) as unknown as Job;

const scanJob = (schoolId: string, materialId: string, storageKey: string, userId: string): Job =>
  ({
    id: randomUUID(),
    name: "scan-material",
    data: { schoolId, materialId, storageKey, uploadedByUserId: userId },
  }) as unknown as Job;

async function sideEffects(schoolId: string) {
  return asSystem(schoolId, async (tx) => ({
    notifications: await tx`SELECT id FROM app.notifications WHERE school_id = ${schoolId}::uuid`,
    events: await tx<{ event_name: string }[]>`
      SELECT event_name FROM app.outbox_events WHERE school_id = ${schoolId}::uuid
    `,
  }));
}

describeDb("a student's own photo: scan -> OCR ingestion", () => {
  test("ends ready with its text, private, with no thumbnail, notification or announcement", async () => {
    const school = await seedSchool();
    const source = await seedPersonalSource(school);
    const photo = await readFixture("photosynthesis-notes.png");
    const s3 = fakeS3();
    s3.objects.set(source.storageKey, Buffer.from(photo));
    const derived: string[] = [];
    const ingestions: string[] = [];

    const clamd = await startFakeClamd(() => "stream: OK");
    try {
      const scanned = await processMaterialScan(
        scanJob(school.schoolId, source.id, source.storageKey, school.studentUserId),
        {
          databaseUrl: databaseUrl!,
          s3: s3.client,
          bucket: "test-bucket",
          clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000, maxFileBytes: 1 << 22 },
          enqueueDerivation: async ({ materialId }) => {
            derived.push(materialId);
          },
          enqueueIngestion: async (_schoolId, materialId) => {
            ingestions.push(materialId);
          },
        },
      );
      expect(scanned).toEqual({ processed: true, outcome: "queued" });
    } finally {
      await clamd.close();
    }
    expect(ingestions).toEqual([source.id]);

    const ingested = await processIngestJob(ingestJob(school.schoolId, source.id), {
      databaseUrl: databaseUrl!,
      fetchBytes: async (key) => new Uint8Array(s3.objects.get(key)!),
      enqueueDerivation: async ({ materialId }) => {
        derived.push(materialId);
      },
    });
    expect(ingested).toMatchObject({ processed: true, ingested: true });

    const rows = await asSystem(
      school.schoolId,
      (tx) => tx<{ content: string; owner_student_id: string | null }[]>`
        SELECT content, owner_student_id FROM app.material_chunks
        WHERE material_id = ${source.id}::uuid
      `,
    );
    expect(rows.map((row) => row.content).join(" ")).toContain("photosynthesis");
    expect(new Set(rows.map((row) => row.owner_student_id))).toEqual(new Set([school.studentId]));
    const [material] = await asSystem(
      school.schoolId,
      (tx) => tx<{ ingest_status: string; published_at: Date | null }[]>`
        SELECT ingest_status::text AS ingest_status, published_at
        FROM app.materials WHERE id = ${source.id}::uuid
      `,
    );
    expect(material).toMatchObject({ ingest_status: "ready", published_at: null });
    expect(derived).toEqual([]);
    const effects = await sideEffects(school.schoolId);
    expect(effects.notifications).toHaveLength(0);
    expect(effects.events.map((event) => event.event_name)).not.toContain("material.published");
  }, 60_000);

  test("an infected upload is blocked without a notification", async () => {
    const school = await seedSchool();
    const source = await seedPersonalSource(school, {
      fileName: "notes.pdf",
      mimeType: "application/pdf",
    });
    const s3 = fakeS3();
    s3.objects.set(source.storageKey, Buffer.from("EICAR"));
    const clamd = await startFakeClamd(() => "stream: Eicar-Test-Signature FOUND");
    try {
      const result = await processMaterialScan(
        scanJob(school.schoolId, source.id, source.storageKey, school.studentUserId),
        {
          databaseUrl: databaseUrl!,
          s3: s3.client,
          bucket: "test-bucket",
          clamd: { host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000, maxFileBytes: 1 << 20 },
          enqueueDerivation: async () => undefined,
        },
      );
      expect(result).toEqual({ processed: true, outcome: "quarantined" });
    } finally {
      await clamd.close();
    }
    expect(s3.objects.has(source.storageKey)).toBe(false);
    const [row] = await asSystem(
      school.schoolId,
      (tx) => tx<{ ingest_status: string }[]>`
        SELECT ingest_status::text AS ingest_status FROM app.materials WHERE id = ${source.id}::uuid
      `,
    );
    expect(row!.ingest_status).toBe("quarantined");
    expect((await sideEffects(school.schoolId)).notifications).toHaveLength(0);
  });
});

describeDb("an assignment as a source", () => {
  test("reads the assignment's text and its attached files in place", async () => {
    const school = await seedSchool();
    const worksheetKey = `permanent/${school.schoolId}/assignments/${randomUUID()}-worksheet.docx`;
    const archiveKey = `permanent/${school.schoolId}/assignments/${randomUUID()}-extras.zip`;
    const sourceId = await asSystem(school.schoolId, async (tx) => {
      const [assignment] = await tx<{ id: string }[]>`
        INSERT INTO app.assignments (
          school_id, class_id, created_by_user_id, last_edited_by_user_id, title, description,
          instructions, status, assigned_at, due_at, max_score
        ) VALUES (
          ${school.schoolId}::uuid, ${school.classId}::uuid, ${school.teacherUserId}::uuid,
          ${school.teacherUserId}::uuid, 'Volcano report',
          'A short report on how volcanoes form.',
          'Describe magma chambers and tectonic plates in two pages.',
          'published', now(), now() + interval '7 days', 20
        )
        RETURNING id
      `;
      for (const [key, name, mime] of [
        [worksheetKey, "worksheet.docx", DOCX],
        [archiveKey, "extras.zip", "application/zip"],
      ] as const) {
        await tx`
          INSERT INTO app.assignment_attachments (
            school_id, assignment_id, uploaded_by_user_id, storage_key, original_file_name,
            mime_type, size_bytes, scan_status
          ) VALUES (
            ${school.schoolId}::uuid, ${assignment!.id}::uuid, ${school.teacherUserId}::uuid,
            ${key}, ${name}, ${mime}, 1024, 'clean'
          )
        `;
      }
      const [source] = await tx<{ id: string }[]>`
        INSERT INTO app.materials (
          school_id, class_id, source_kind, assignment_id, uploaded_by_user_id,
          last_edited_by_user_id, title, storage_key, original_file_name, mime_type, size_bytes,
          ai_visible, ingest_status
        ) VALUES (
          ${school.schoolId}::uuid, ${school.classId}::uuid, 'assignment', ${assignment!.id}::uuid,
          ${school.teacherUserId}::uuid, ${school.teacherUserId}::uuid, 'Volcano report', NULL,
          'Volcano report', 'application/vnd.studafy.assignment', 2048, true, 'queued'
        )
        RETURNING id
      `;
      return source!.id;
    });

    const worksheet = await buildDocx(
      "Worksheet",
      ["Pyroclastic flows move faster than most cars."],
      [],
    );
    const fetched: string[] = [];
    const derived: string[] = [];
    const result = await processIngestJob(ingestJob(school.schoolId, sourceId), {
      databaseUrl: databaseUrl!,
      fetchBytes: async (key) => {
        fetched.push(key);
        if (key === worksheetKey) return new Uint8Array(worksheet);
        return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      },
      enqueueDerivation: async ({ materialId }) => {
        derived.push(materialId);
      },
    });
    expect(result).toMatchObject({ processed: true, ingested: true });
    expect(fetched).toContain(worksheetKey);

    const chunks = await asSystem(
      school.schoolId,
      (tx) => tx<{ content: string; section_title: string | null }[]>`
        SELECT content, section_title FROM app.material_chunks
        WHERE material_id = ${sourceId}::uuid ORDER BY chunk_index
      `,
    );
    const text = chunks.map((chunk) => chunk.content).join("\n");
    expect(text).toContain("Describe magma chambers and tectonic plates");
    expect(text).toContain("Pyroclastic flows move faster than most cars.");
    expect(chunks.map((chunk) => chunk.section_title)).toContain("Volcano report");
    expect(chunks.some((chunk) => chunk.section_title !== "Volcano report")).toBe(true);
    expect(derived).toEqual([]);
    expect((await sideEffects(school.schoolId)).notifications).toHaveLength(0);
  });
});

describeDb("retention and erasure of a student's own sources", () => {
  test("the sweep deletes a source at the end of its retention period, file and all", async () => {
    const school = await seedSchool();
    const old = await seedPersonalSource(school, {
      fileName: "old.pdf",
      mimeType: "application/pdf",
      createdAt: new Date(Date.now() - (PERSONAL_SOURCE_RETENTION_DAYS + 5) * 86_400_000),
    });
    const fresh = await seedPersonalSource(school, {
      fileName: "fresh.pdf",
      mimeType: "application/pdf",
    });
    const objects = new Map<string, number>([
      [old.storageKey, 2048],
      [fresh.storageKey, 2048],
    ]);

    const result = await purgeAbandonedMaterials(sql, {
      head: async (key) => (objects.has(key) ? { sizeBytes: objects.get(key)! } : null),
      remove: async (key) => {
        objects.delete(key);
      },
    });
    expect(result.expiredPersonalSources).toBeGreaterThanOrEqual(1);
    expect(objects.has(old.storageKey)).toBe(false);
    expect(objects.has(fresh.storageKey)).toBe(true);
    const left = await asSystem(
      school.schoolId,
      (tx) => tx<{ id: string }[]>`
        SELECT id FROM app.materials WHERE id IN (${old.id}::uuid, ${fresh.id}::uuid)
      `,
    );
    expect(left.map((row) => row.id)).toEqual([fresh.id]);
  });

  test("erasing a student deletes their own sources and hands back the files", async () => {
    const school = await seedSchool();
    const other = await seedSchool();
    const mine = await seedPersonalSource(school, {
      fileName: "a.pdf",
      mimeType: "application/pdf",
    });
    const theirs = await seedPersonalSource(other, {
      fileName: "b.pdf",
      mimeType: "application/pdf",
    });

    const erased = await asSystem(school.schoolId, (tx) =>
      erasePersonalAiSources(tx, school.schoolId, {
        userId: school.studentUserId,
        studentId: school.studentId,
        teacherId: null,
      }),
    );
    expect(erased.storageKeys).toEqual([mine.storageKey]);
    expect(erased.redacted).toEqual([
      { table: "materials", action: "hard_deleted", columns: [], rows: 1 },
    ]);
    const left = await asSystem(
      other.schoolId,
      (tx) => tx`SELECT id FROM app.materials WHERE id = ${theirs.id}::uuid`,
    );
    expect(left).toHaveLength(1);
  });
});
