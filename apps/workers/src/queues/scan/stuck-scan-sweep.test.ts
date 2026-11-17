/**
 * QA-055: an upload never stays unscanned or stuck, and a forgotten status fails closed.
 *
 * - The API enqueues a file's scan after the upload commits and only logs a failed enqueue, so a
 *   Redis blip left the file `scanning` (unserved) forever. The sweep re-enqueues every file still
 *   `scanning` after 15 minutes, and every file left `unscanned` from before scanning existed (the
 *   backfill 000192 deferred).
 * - Four tables default the status to the servable `unscanned`, because their file is optional. A
 *   write path that set the key and forgot the status served an unscanned file. A trigger now turns
 *   `unscanned` into `scanning` whenever a key is written.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/queues/scan/stuck-scan-sweep.test.ts
 */

import { randomUUID } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { STUCK_SCAN_AFTER_MS, sweepStuckUploadScans } from "./stuck-scan-sweep";

import type { UploadScanJobRequest } from "./stuck-scan-sweep";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
let sql: Sql;

beforeAll(() => {
  if (databaseUrl) sql = postgres(databaseUrl, { max: 2 });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

interface Seeded {
  schoolId: string;
  userId: string;
}

async function seedSchool(): Promise<Seeded> {
  const tag = `sweep-${randomUUID().slice(0, 8)}`;
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
             (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const email = `${tag}@admin.local`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${tag}, ${email}, ${email}, ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    await tx`SELECT set_config('app.school_id', ${school!.id}, true)`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${school!.id}::uuid, ${`u-${email}`}, ${`u-${email}`}, 'Uploader', 'active')
      RETURNING id
    `;
    return { schoolId: school!.id, userId: user!.id };
  });
}

/** An import row with a source file, its status and its last update set as given. */
async function importRow(s: Seeded, status: string | null, updatedAgoMs: number): Promise<string> {
  const key = `permanent/${s.schoolId}/${randomUUID()}/students.csv`;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${s.schoolId}, true)`;
    const at = new Date(Date.now() - updatedAgoMs);
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.student_imports
        (school_id, uploaded_by, file_name, source_storage_key, source_file_name,
         source_size_bytes, source_uploaded_at, created_at)
      VALUES (${s.schoolId}::uuid, ${s.userId}::uuid, 'students.csv', ${key}, 'students.csv', 68,
              ${at}, ${at})
      RETURNING id
    `;
    if (status !== null) {
      // The trigger fires on key writes only, so a status-only update sets it as given.
      await tx`
        UPDATE app.student_imports SET source_scan_status = ${status}::app.upload_scan_status,
               updated_at = ${at}
        WHERE id = ${row!.id}::uuid
      `;
    }
  });
  return key;
}

async function importStatus(s: Seeded, key: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${s.schoolId}, true)`;
    const [row] = await tx<{ status: string }[]>`
      SELECT source_scan_status::text AS status FROM app.student_imports
      WHERE source_storage_key = ${key}
    `;
    return row!.status;
  });
}

describeDb("stuck and unscanned uploads are swept (QA-055)", () => {
  test("re-enqueues stuck and never-scanned files, and nothing else", async () => {
    const s = await seedSchool();
    const stuck = await importRow(s, "scanning", STUCK_SCAN_AFTER_MS + 5 * 60_000);
    const fresh = await importRow(s, "scanning", 60_000);
    const legacy = await importRow(s, "unscanned", 30 * 86_400_000);
    const clean = await importRow(s, "clean", STUCK_SCAN_AFTER_MS * 4);

    const enqueued: UploadScanJobRequest[] = [];
    const result = await sweepStuckUploadScans(sql, async (requests) => {
      enqueued.push(...requests);
    });

    const keys = enqueued.filter((r) => r.schoolId === s.schoolId).map((r) => r.storageKey);
    expect(keys.sort()).toEqual([legacy, stuck].sort());
    expect(keys).not.toContain(fresh);
    expect(keys).not.toContain(clean);
    expect(enqueued.find((r) => r.storageKey === stuck)!.target).toBe("import_source");
    expect(result.enqueued).toBeGreaterThanOrEqual(2);
  });

  test("a key written with the default status starts as scanning, not servable", async () => {
    const s = await seedSchool();
    const key = await importRow(s, null, 0);
    expect(await importStatus(s, key)).toBe("scanning");
  });
});
