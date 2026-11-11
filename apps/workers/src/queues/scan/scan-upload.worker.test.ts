/**
 * Upload malware scan (file-scan queue, scan-upload job; F-14) tests.
 *
 * Same conventions as scan-material.worker.test.ts: a real migrated database (skipped unless
 * TEST_DATABASE_URL is set), a TCP fake clamd, and an in-memory S3 behind ScanS3Client. The fake
 * clamd answers like the real one does for the EICAR test string -- FOUND when the streamed bytes
 * contain it, OK otherwise -- so the verdict follows the file, not the test's say-so.
 */

import { randomUUID } from "node:crypto";

import { UPLOAD_SCAN_TARGETS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  processUploadScan,
  scanUploadJobDataSchema,
  UPLOAD_SCAN_TARGET_SPECS,
  uploadScanFailedListener,
  type ScanUploadConfig,
} from "./scan-upload.worker";
import { startFakeClamd } from "./test-clamd-server";

import type { ScanS3Client } from "./s3";
import type { Sql, TransactionSql } from "postgres";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

describe("upload scan targets", () => {
  test("every target the API can enqueue has a worker entry", () => {
    expect(Object.keys(UPLOAD_SCAN_TARGET_SPECS).sort()).toEqual([...UPLOAD_SCAN_TARGETS].sort());
  });

  test("a school id is required exactly for per-school targets", () => {
    const key = "permanent/x/y/z.pdf";
    expect(
      scanUploadJobDataSchema.safeParse({
        target: "submission_attachment",
        schoolId: null,
        storageKey: key,
      }).success,
    ).toBe(false);
    expect(
      scanUploadJobDataSchema.safeParse({
        target: "school_application_proof",
        schoolId: randomUUID(),
        storageKey: key,
      }).success,
    ).toBe(false);
    expect(
      scanUploadJobDataSchema.safeParse({
        target: "school_application_proof",
        schoolId: null,
        storageKey: key,
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// In-memory S3 fake
// ---------------------------------------------------------------------------

function notFound(): Error {
  return Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } });
}

function createFakeS3() {
  const objects = new Map<string, Buffer>();
  const copies: { Key: string; SSEKMSKeyId?: string }[] = [];
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
    async copyObject({ Bucket, Key, CopySource, SSEKMSKeyId }) {
      const bytes = objects.get(CopySource.slice(Bucket.length + 1));
      if (!bytes) throw notFound();
      objects.set(Key, Buffer.from(bytes));
      copies.push({ Key, ...(SSEKMSKeyId ? { SSEKMSKeyId } : {}) });
    },
    async deleteObject({ Key }) {
      objects.delete(Key);
    },
  };
  return { client, objects, copies };
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

function config(s3: ScanS3Client, extra: Partial<ScanUploadConfig> = {}): ScanUploadConfig {
  return {
    databaseUrl: databaseUrl!,
    s3,
    bucket: "test-bucket",
    // Replaced per scan by `scan` below; a fake clamd accumulates every payload it is sent.
    clamd: { host: "127.0.0.1", port: 0, timeoutMs: 5_000, maxFileBytes: 1 << 20 },
    ...extra,
  };
}

/**
 * Run one scan against a fresh fake clamd that answers like the real one for EICAR: FOUND when the
 * streamed bytes contain the test string, OK otherwise.
 */
async function scan(jobLike: { data: unknown }, cfg: ScanUploadConfig) {
  const clamd = await startFakeClamd((payload) =>
    payload.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"))
      ? "stream: Win.Test.EICAR_HDB-1 FOUND"
      : "stream: OK",
  );
  try {
    return await processUploadScan(jobLike, { ...cfg, clamd: { ...cfg.clamd, port: clamd.port } });
  } finally {
    await clamd.close();
  }
}

interface Fixture {
  schoolId: string;
  submissionKey: string;
  messageKey: string;
  importKey: string;
}

let fixtureSeq = 0;

/**
 * A school with a class, a student's submission with one attached file, a parent-teacher thread with
 * one image, and an import with its original file — every file row as the API leaves it on upload:
 * `scanning`. Seeded as studafy_admin, as scan-material.worker.test.ts does.
 */
async function seedFixture(): Promise<Fixture> {
  fixtureSeq += 1;
  const tag = `upscan${fixtureSeq}-${Date.now().toString(36)}`;

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

    const user = async (label: string) => {
      const email = `${label}-${tag}@t.local`;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${email}, ${email}, ${label}, 'active')
        RETURNING id
      `;
      return row!.id;
    };
    const teacherUserId = await user("teacher");
    const studentUserId = await user("student");
    const parentUserId = await user("parent");

    const classId = await seedClass(tx, schoolId, teacherUserId, tag);

    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${schoolId}::uuid, ${studentUserId}::uuid, ${`ADM-${tag}`}, 'Sam', 'Student')
      RETURNING id
    `;
    const [assignment] = await tx<{ id: string }[]>`
      INSERT INTO app.assignments
        (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, due_at, max_score)
      VALUES (${schoolId}::uuid, ${classId}::uuid, ${teacherUserId}::uuid, ${teacherUserId}::uuid,
              'Homework', now() + interval '7 days', 10)
      RETURNING id
    `;
    const [submission] = await tx<{ id: string }[]>`
      INSERT INTO app.assignment_submissions
        (school_id, assignment_id, student_id, last_edited_by_user_id)
      VALUES (${schoolId}::uuid, ${assignment!.id}::uuid, ${student!.id}::uuid,
              ${studentUserId}::uuid)
      RETURNING id
    `;
    const submissionKey = `permanent/${schoolId}/${randomUUID()}/homework.pdf`;
    await tx`
      INSERT INTO app.submission_attachments
        (school_id, submission_id, uploaded_by_user_id, storage_key, original_file_name,
         mime_type, size_bytes)
      VALUES (${schoolId}::uuid, ${submission!.id}::uuid, ${studentUserId}::uuid, ${submissionKey},
              'homework.pdf', 'application/pdf', 68)
    `;

    const [conversation] = await tx<{ id: string }[]>`
      INSERT INTO app.message_conversations (school_id, parent_user_id, teacher_user_id, student_id)
      VALUES (${schoolId}::uuid, ${parentUserId}::uuid, ${teacherUserId}::uuid, ${student!.id}::uuid)
      RETURNING id
    `;
    const [message] = await tx<{ id: string }[]>`
      INSERT INTO app.messages (school_id, conversation_id, sender_user_id, body)
      VALUES (${schoolId}::uuid, ${conversation!.id}::uuid, ${parentUserId}::uuid, 'See attached')
      RETURNING id
    `;
    const messageKey = `permanent/${schoolId}/${randomUUID()}/photo.png`;
    await tx`
      INSERT INTO app.message_attachments
        (school_id, message_id, position, storage_key, original_file_name, mime_type, size_bytes)
      VALUES (${schoolId}::uuid, ${message!.id}::uuid, 0, ${messageKey}, 'photo.png',
              'image/png', 68)
    `;

    const importKey = `permanent/${schoolId}/${randomUUID()}/students.csv`;
    await tx`
      INSERT INTO app.student_imports
        (school_id, uploaded_by, file_name, source_storage_key, source_file_name,
         source_size_bytes, source_uploaded_at, source_scan_status)
      VALUES (${schoolId}::uuid, ${teacherUserId}::uuid, 'students.csv', ${importKey},
              'students.csv', 68, now(), 'scanning')
    `;

    return { schoolId, submissionKey, messageKey, importKey };
  });
}

async function seedClass(
  tx: TransactionSql,
  schoolId: string,
  teacherUserId: string,
  tag: string,
): Promise<string> {
  const [teacher] = await tx<{ id: string }[]>`
    INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
    VALUES (${schoolId}::uuid, ${teacherUserId}::uuid, ${`EMP-${tag}`}, 'active')
    RETURNING id
  `;
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
            ${teacher!.id}::uuid, ${room!.id}::uuid, ${`CLS-${tag}`}, 32, 'active')
    RETURNING id
  `;
  return cls!.id;
}

/** A pending school application with its proof, as submitApplication leaves it. */
async function seedApplication(): Promise<string> {
  const key = `permanent/school-applications/${randomUUID()}/proof.pdf`;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`
      INSERT INTO app.school_applications (
        provider, provider_subject, applicant_email, applicant_name, applicant_phone, school_name,
        country_id, default_currency_id, city, address, proof_storage_key, proof_file_name,
        proof_content_type, proof_size_bytes
      ) VALUES (
        'mock', ${randomUUID()}, ${`a-${randomUUID().slice(0, 8)}@t.local`}, 'Applicant', '+100',
        'New School',
        (SELECT id FROM app.countries WHERE alpha2_code = 'US'),
        (SELECT id FROM app.currencies WHERE code = 'USD'),
        'City', '1 Road', ${key}, 'proof.pdf', 'application/pdf', 68
      )
    `;
  });
  return key;
}

async function statusOf(
  schoolId: string | null,
  table: string,
  keyColumn: string,
  statusColumn: string,
  key: string,
): Promise<string | undefined> {
  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ status: string }[]>`
      SELECT ${tx(statusColumn)}::text AS status FROM ${tx(`app.${table}`)}
      WHERE ${tx(keyColumn)} = ${key}
    `;
    return row?.status;
  });
}

const submissionStatus = (f: Fixture) =>
  statusOf(f.schoolId, "submission_attachments", "storage_key", "scan_status", f.submissionKey);
const messageStatus = (f: Fixture) =>
  statusOf(f.schoolId, "message_attachments", "storage_key", "scan_status", f.messageKey);

const job = (target: string, schoolId: string | null, storageKey: string) => ({
  data: { target, schoolId, storageKey },
});

describeDb("upload scan target registry against the schema", () => {
  test("every target names a real table, key column and upload_scan_status column", async () => {
    for (const [target, spec] of Object.entries(UPLOAD_SCAN_TARGET_SPECS)) {
      const columns = await sql<{ column_name: string; udt_name: string }[]>`
        SELECT column_name, udt_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = ${spec.table}
      `;
      const types = new Map(columns.map((column) => [column.column_name, column.udt_name]));
      expect({ target, key: types.get(spec.keyColumn) }).toEqual({ target, key: "text" });
      expect({ target, status: types.get(spec.statusColumn) }).toEqual({
        target,
        status: "upload_scan_status",
      });
      expect({ target, school: types.has("school_id") }).toEqual({
        target,
        school: spec.scope === "school",
      });
      if (spec.sensitive === "column") expect(types.get("sensitive")).toBe("bool");
    }
  });

  test("every target's queries run: a key no row holds is skipped", async () => {
    const s3 = createFakeS3();
    for (const [target, spec] of Object.entries(UPLOAD_SCAN_TARGET_SPECS)) {
      const global = spec.scope === "global";
      const result = await scan(
        job(
          target,
          global ? null : randomUUID(),
          `permanent/${randomUUID()}/${randomUUID()}/x.pdf`,
        ),
        config(s3.client),
      );
      expect({ target, result }).toEqual({
        target,
        result: { processed: true, outcome: "skipped" },
      });
    }
  });
});

describeDb("processUploadScan", () => {
  test("an infected submission file is quarantined and the served copy deleted", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(f.submissionKey, Buffer.from(EICAR));
    const alerts: Record<string, unknown>[] = [];

    const result = await scan(
      job("submission_attachment", f.schoolId, f.submissionKey),
      config(s3.client, { log: { error: (fields) => alerts.push(fields) } }),
    );

    expect(result).toEqual({ processed: true, outcome: "quarantined" });
    expect(await submissionStatus(f)).toBe("quarantined");
    expect(s3.objects.has(f.submissionKey)).toBe(false);
    const quarantineKey = f.submissionKey.replace(/^permanent\//, "quarantine/");
    expect(s3.objects.get(quarantineKey)?.toString()).toBe(EICAR);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      event: "upload_quarantined",
      target: "submission_attachment",
      virus: "Win.Test.EICAR_HDB-1",
    });
  });

  test("a clean submission file is marked clean and stays in place", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(f.submissionKey, Buffer.from("%PDF-1.7 my essay"));

    const result = await scan(
      job("submission_attachment", f.schoolId, f.submissionKey),
      config(s3.client),
    );

    expect(result).toEqual({ processed: true, outcome: "clean" });
    expect(await submissionStatus(f)).toBe("clean");
    expect(s3.objects.has(f.submissionKey)).toBe(true);
    expect(s3.copies).toHaveLength(0);
  });

  test("an infected message image is quarantined; a clean one is marked clean", async () => {
    const infected = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(infected.messageKey, Buffer.from(EICAR));
    expect(
      await scan(
        job("message_attachment", infected.schoolId, infected.messageKey),
        config(s3.client),
      ),
    ).toEqual({ processed: true, outcome: "quarantined" });
    expect(await messageStatus(infected)).toBe("quarantined");
    expect(s3.objects.has(infected.messageKey)).toBe(false);

    const clean = await seedFixture();
    s3.objects.set(clean.messageKey, Buffer.from("\x89PNG harmless"));
    expect(
      await scan(job("message_attachment", clean.schoolId, clean.messageKey), config(s3.client)),
    ).toEqual({ processed: true, outcome: "clean" });
    expect(await messageStatus(clean)).toBe("clean");
    expect(s3.objects.has(clean.messageKey)).toBe(true);
  });

  test("only the scanned school's row is touched", async () => {
    const a = await seedFixture();
    const b = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(a.submissionKey, Buffer.from("clean"));
    // The job names school b but a's key: no row of b's holds it, so nothing is decided.
    expect(
      await scan(job("submission_attachment", b.schoolId, a.submissionKey), config(s3.client)),
    ).toEqual({ processed: true, outcome: "skipped" });
    expect(await submissionStatus(a)).toBe("scanning");
  });

  test("a duplicate job after the verdict is a no-op", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(f.submissionKey, Buffer.from(EICAR));
    const again = () =>
      scan(job("submission_attachment", f.schoolId, f.submissionKey), config(s3.client));
    expect(await again()).toEqual({ processed: true, outcome: "quarantined" });
    expect(await again()).toEqual({ processed: true, outcome: "skipped" });
    expect(s3.copies).toHaveLength(1);
  });

  test("a stale job for a key no row holds any more is skipped", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    const result = await scan(
      job("submission_attachment", f.schoolId, `permanent/${f.schoolId}/${randomUUID()}/gone.pdf`),
      config(s3.client),
    );
    expect(result).toEqual({ processed: true, outcome: "skipped" });
  });

  test("a file uploaded before scanning (unscanned) is scanned by a backfill job", async () => {
    const f = await seedFixture();
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
      await tx`
        UPDATE app.submission_attachments SET scan_status = 'unscanned'
        WHERE storage_key = ${f.submissionKey}
      `;
    });
    const s3 = createFakeS3();
    s3.objects.set(f.submissionKey, Buffer.from(EICAR));

    expect(
      await scan(job("submission_attachment", f.schoolId, f.submissionKey), config(s3.client)),
    ).toEqual({ processed: true, outcome: "quarantined" });
    expect(await submissionStatus(f)).toBe("quarantined");
  });

  test("a retry after the served copy was deleted recovers from the quarantine copy", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(f.submissionKey.replace(/^permanent\//, "quarantine/"), Buffer.from(EICAR));

    expect(
      await scan(job("submission_attachment", f.schoolId, f.submissionKey), config(s3.client)),
    ).toEqual({ processed: true, outcome: "quarantined" });
    expect(await submissionStatus(f)).toBe("quarantined");
    expect(s3.copies).toHaveLength(0);
  });

  test("a scan error throws and leaves the file unserved", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(f.submissionKey, Buffer.from("anything"));
    const broken = await startFakeClamd(() => "INSTREAM size limit exceeded. ERROR");
    try {
      await expect(
        processUploadScan(job("submission_attachment", f.schoolId, f.submissionKey), {
          ...config(s3.client),
          clamd: { host: "127.0.0.1", port: broken.port, timeoutMs: 5_000, maxFileBytes: 1 << 20 },
        }),
      ).rejects.toThrow(/clamd scan failed/);
      expect(await submissionStatus(f)).toBe("scanning");
    } finally {
      await broken.close();
    }
  });

  test("clamd unreachable fails closed: the job throws and the file stays unserved", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(f.submissionKey, Buffer.from("anything"));
    // A port nothing listens on: grab one, then close it.
    const closed = await startFakeClamd(() => "stream: OK");
    const port = closed.port;
    await closed.close();
    await expect(
      processUploadScan(job("submission_attachment", f.schoolId, f.submissionKey), {
        ...config(s3.client),
        clamd: { host: "127.0.0.1", port, timeoutMs: 2_000, maxFileBytes: 1 << 20 },
      }),
    ).rejects.toThrow();
    expect(await submissionStatus(f)).toBe("scanning");
    expect(s3.objects.has(f.submissionKey)).toBe(true);
  });

  test("a terminally failed scan marks the file failed", async () => {
    const f = await seedFixture();
    const logged: string[] = [];
    const listener = uploadScanFailedListener(databaseUrl!, {
      warn: () => undefined,
      error: (fields) => logged.push(String(fields.event)),
    });
    listener(
      {
        id: "1",
        name: "scan-upload",
        data: {
          target: "submission_attachment",
          schoolId: f.schoolId,
          storageKey: f.submissionKey,
        },
        attemptsMade: 3,
        finishedOn: Date.now(),
      },
      new Error("clamd unreachable"),
    );
    for (let i = 0; i < 50 && (await submissionStatus(f)) !== "failed"; i += 1) {
      await Bun.sleep(20);
    }
    expect(await submissionStatus(f)).toBe("failed");
    expect(logged).toContain("upload_scan_failed");
  });

  test("a row pointing at another school's object is failed, and that object left alone", async () => {
    const f = await seedFixture();
    const other = await seedFixture();
    // A row saved before migration 000197, which may still hold another school's key: the trigger
    // trg_expense_cache_attachment_key_school stops new ones being written. Recreate one by
    // disabling the trigger for this insert only, inside the same transaction.
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
      await tx.unsafe(
        "ALTER TABLE app.expense_cache DISABLE TRIGGER trg_expense_cache_attachment_key_school",
      );
      await tx`
        INSERT INTO app.expense_cache (
          school_id, document_type, category, vendor, currency_id, amount_minor, erpnext_docname,
          erpnext_status, attachment_storage_key, attachment_scan_status, last_synced_at
        ) VALUES (
          ${f.schoolId}::uuid, 'purchase_invoice', 'supplies', 'Acme',
          (SELECT id FROM app.currencies WHERE code = 'USD'), 5000, 'ACC-1', 'Submitted',
          ${other.submissionKey}, 'scanning', now()
        )
      `;
      await tx.unsafe(
        "ALTER TABLE app.expense_cache ENABLE TRIGGER trg_expense_cache_attachment_key_school",
      );
    });
    const s3 = createFakeS3();
    s3.objects.set(other.submissionKey, Buffer.from(EICAR));

    expect(
      await scan(job("expense_attachment", f.schoolId, other.submissionKey), config(s3.client)),
    ).toEqual({ processed: true, outcome: "rejected" });
    expect(s3.objects.has(other.submissionKey)).toBe(true);
    expect(s3.copies).toHaveLength(0);
    expect(
      await statusOf(
        f.schoolId,
        "expense_cache",
        "attachment_storage_key",
        "attachment_scan_status",
        other.submissionKey,
      ),
    ).toBe("failed");
  });

  test("a school application proof (no school) is scanned under the system role", async () => {
    const key = await seedApplication();
    const s3 = createFakeS3();
    s3.objects.set(key, Buffer.from(EICAR));
    expect(await scan(job("school_application_proof", null, key), config(s3.client))).toEqual({
      processed: true,
      outcome: "quarantined",
    });
    expect(
      await statusOf(null, "school_applications", "proof_storage_key", "proof_scan_status", key),
    ).toBe("quarantined");
  });

  test("a sensitive file's quarantine copy is held under the sensitive-documents key", async () => {
    const f = await seedFixture();
    const s3 = createFakeS3();
    s3.objects.set(f.importKey, Buffer.from(`name\n${EICAR}`));
    expect(
      await scan(
        job("import_source", f.schoolId, f.importKey),
        config(s3.client, { sensitiveKmsKeyId: "alias/studafy-records" }),
      ),
    ).toEqual({ processed: true, outcome: "quarantined" });
    expect(s3.copies).toEqual([
      {
        Key: f.importKey.replace(/^permanent\//, "quarantine/"),
        SSEKMSKeyId: "alias/studafy-records",
      },
    ]);
    expect(
      await statusOf(
        f.schoolId,
        "student_imports",
        "source_storage_key",
        "source_scan_status",
        f.importKey,
      ),
    ).toBe("quarantined");
  });
});
