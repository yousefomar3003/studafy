/**
 * The abandoned material sweep, against a real database.
 *
 * Seeds one class with materials of every age and state that matters and an in-memory bucket, then
 * proves: only an AI-visible upload never confirmed for over 24 hours and a material failed for over
 * 14 days are deleted; their files are removed and exactly their bytes released; a file another row
 * still points at is kept; a confirmed material whose AI use is off ('uploaded', ai_visible off), a
 * fresh upload, a recent failure and every other state stay; each deletion is logged. Skipped
 * unless TEST_DATABASE_URL is set; the database must already be migrated.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/queues/maintenance/abandoned-material-sweep.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { purgeAbandonedMaterials } from "./abandoned-material-sweep";

import type { MaterialObjectStore, MaterialSweepLogger } from "./abandoned-material-sweep";
import type { Sql, TransactionSql } from "postgres";

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

function fakeBucket(): MaterialObjectStore & { objects: Map<string, number> } {
  const objects = new Map<string, number>();
  return {
    objects,
    head: async (key) => {
      const sizeBytes = objects.get(key);
      return sizeBytes === undefined ? null : { sizeBytes };
    },
    remove: async (key) => {
      objects.delete(key);
    },
  };
}

function asSchool<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

let seq = 0;

/** A school with one class taught by one teacher. */
async function seedClass(): Promise<{ schoolId: string; classId: string; userId: string }> {
  seq += 1;
  const tag = `msweep${seq}-${Date.now().toString(36)}`;
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
             (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`Sweep ${tag}`}, ${`${tag}@admin.local`}, ${`${tag}@admin.local`},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${`u-${tag}@t.local`}, ${`u-${tag}@t.local`}, 'Teacher', 'active')
      RETURNING id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${schoolId}::uuid, ${user!.id}::uuid, ${`EMP-${tag}`}, 'active') RETURNING id
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${`AY-${tag}`}, 'AY', '2026-01-01'::date, '2026-12-31'::date, 'active')
      RETURNING id
    `;
    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${year!.id}::uuid, ${`T-${tag}`}, 'T', 1::smallint,
              '2026-01-01'::date, '2026-06-30'::date, 'active')
      RETURNING id
    `;
    const [subject] = await tx<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${schoolId}::uuid, ${`SUB-${tag}`}, 'Subject', 'active') RETURNING id
    `;
    const [course] = await tx<{ id: string }[]>`
      INSERT INTO app.courses (school_id, subject_id, code, name, credit_hours, status)
      VALUES (${schoolId}::uuid, ${subject!.id}::uuid, ${`CRS-${tag}`}, 'Course', 1, 'active')
      RETURNING id
    `;
    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${schoolId}::uuid, ${`RM-${tag}`}, 'Room', 'physical', 30, 'Main') RETURNING id
    `;
    const [cls] = await tx<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity,
         status)
      VALUES (${schoolId}::uuid, ${course!.id}::uuid, ${year!.id}::uuid, ${term!.id}::uuid,
              ${teacher!.id}::uuid, ${room!.id}::uuid, ${`CLS-${tag}`}, 32, 'active')
      RETURNING id
    `;
    return { schoolId, classId: cls!.id, userId: user!.id };
  });
}

interface Seed {
  status: string;
  /** How long ago it was created, and (for a failure) when it failed. */
  age: string;
  aiVisible?: boolean;
  key?: string;
}

async function seedMaterial(
  f: { schoolId: string; classId: string; userId: string },
  seed: Seed,
): Promise<{ id: string; key: string }> {
  const key = seed.key ?? `permanent/${f.schoolId}/materials/${crypto.randomUUID()}-file.pdf`;
  const error = seed.status === "failed" || seed.status === "quarantined" ? "test error" : null;
  const [row] = await asSchool(
    f.schoolId,
    (tx) => tx<{ id: string }[]>`
      INSERT INTO app.materials (
        school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, storage_key,
        original_file_name, mime_type, size_bytes, ai_visible, ingest_status, ingest_error,
        ingested_at, created_at, updated_at
      ) VALUES (
        ${f.schoolId}::uuid, ${f.classId}::uuid, ${f.userId}::uuid, ${f.userId}::uuid,
        ${`${seed.status} ${seed.age}`}, ${key}, 'file.pdf', 'application/pdf', 1000,
        ${seed.aiVisible ?? true}, ${seed.status}::app.material_ingest_status, ${error},
        CASE WHEN ${seed.status} = 'ready' THEN now() - ${seed.age}::interval END,
        now() - ${seed.age}::interval, now() - ${seed.age}::interval
      )
      RETURNING id
    `,
  );
  return { id: row!.id, key };
}

async function remainingIds(schoolId: string): Promise<string[]> {
  const rows = await asSchool(
    schoolId,
    (tx) => tx<{ id: string }[]>`SELECT id FROM app.materials WHERE school_id = ${schoolId}::uuid`,
  );
  return rows.map((row) => row.id).sort();
}

async function meter(schoolId: string): Promise<number> {
  const [row] = await asSchool(
    schoolId,
    (tx) => tx<{ bytes_used: string }[]>`
      SELECT bytes_used::text AS bytes_used FROM app.storage_usage_meters
      WHERE school_id = ${schoolId}::uuid
    `,
  );
  return Number(row?.bytes_used ?? 0);
}

describeDb("purgeAbandonedMaterials", () => {
  test("deletes only stale unconfirmed uploads and long-failed materials, freeing their files", async () => {
    const f = await seedClass();
    const bucket = fakeBucket();

    const staleUpload = await seedMaterial(f, { status: "uploaded", age: "25 hours" });
    const oldFailure = await seedMaterial(f, { status: "failed", age: "15 days" });
    const kept = [
      await seedMaterial(f, { status: "uploaded", age: "23 hours" }),
      // A confirmed material whose AI use was turned off: 'uploaded' with ai_visible off.
      await seedMaterial(f, { status: "uploaded", age: "60 days", aiVisible: false }),
      await seedMaterial(f, { status: "failed", age: "13 days" }),
      await seedMaterial(f, { status: "ready", age: "60 days" }),
      await seedMaterial(f, { status: "scanning", age: "60 days" }),
      await seedMaterial(f, { status: "queued", age: "60 days" }),
      await seedMaterial(f, { status: "processing", age: "60 days" }),
      await seedMaterial(f, { status: "quarantined", age: "60 days" }),
    ];
    for (const m of [staleUpload, oldFailure, ...kept]) bucket.objects.set(m.key, 1000);
    // The thumbnail of the old failure (from a time it was ready) goes with it.
    const thumbnail = `permanent/${f.schoolId}/${oldFailure.id}/thumbnail.jpg`;
    bucket.objects.set(thumbnail, 50);
    await asSchool(f.schoolId, async (tx) => {
      await tx`UPDATE app.materials SET thumbnail_key = ${thumbnail} WHERE id = ${oldFailure.id}`;
      await tx`SELECT app.set_storage_usage(${10_050})`;
    });

    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const log: MaterialSweepLogger = {
      info: (fields, message) => lines.push({ fields, message }),
      warn: (fields, message) => lines.push({ fields, message }),
    };

    const result = await purgeAbandonedMaterials(sql, bucket, new Date(), log);

    expect(result.abandonedUploads).toBeGreaterThanOrEqual(1);
    expect(result.failedMaterials).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(await remainingIds(f.schoolId)).toEqual(kept.map((m) => m.id).sort());
    expect(bucket.objects.has(staleUpload.key)).toBe(false);
    expect(bucket.objects.has(oldFailure.key)).toBe(false);
    expect(bucket.objects.has(thumbnail)).toBe(false);
    for (const m of kept) expect(bucket.objects.has(m.key)).toBe(true);
    expect(await meter(f.schoolId)).toBe(10_050 - 2_050);

    const swept = lines.filter((line) => line.fields.school_id === f.schoolId);
    expect(
      swept.map((line) => [line.fields.material_id, line.fields.ingest_status]).sort(),
    ).toEqual(
      [
        [oldFailure.id, "failed"],
        [staleUpload.id, "uploaded"],
      ].sort(),
    );
    expect(swept.every((line) => line.fields.event === "material_swept")).toBe(true);
  });

  test("keeps a file another row still points at", async () => {
    const f = await seedClass();
    const bucket = fakeBucket();
    const shared = `permanent/${f.schoolId}/materials/${crypto.randomUUID()}-shared.pdf`;
    const stale = await seedMaterial(f, { status: "failed", age: "20 days", key: shared });
    bucket.objects.set(shared, 1000);
    // An expense may be given any of its school's permanent/ keys.
    await asSchool(
      f.schoolId,
      (tx) => tx`
        INSERT INTO app.expense_cache (
          school_id, document_type, category, vendor, currency_id, amount_minor,
          erpnext_docname, erpnext_status, last_synced_at, attachment_storage_key
        ) VALUES (
          ${f.schoolId}::uuid, 'expense_claim', 'Supplies', 'Stationer',
          (SELECT id FROM app.currencies WHERE code = 'USD'), 100,
          ${`EXP-${crypto.randomUUID().slice(0, 8)}`}, 'Draft', CURRENT_TIMESTAMP, ${shared}
        )
      `,
    );

    await purgeAbandonedMaterials(sql, bucket);

    expect(await remainingIds(f.schoolId)).not.toContain(stale.id);
    expect(bucket.objects.has(shared)).toBe(true);
  });
});
