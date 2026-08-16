/**
 * The abandoned student-import purge sweep (ST-190 follow-up), against a real database.
 *
 * Seeds a school with student_imports rows across every lifecycle status, old and recent, and
 * drives the sweep with an injected clock so retention math is deterministic. The acceptance the
 * test proves: only `uploaded`/`validated` rows older than the retention window are removed —
 * a recent unconfirmed upload and every row that already committed to (or ran) student creation
 * (`confirmed`, `processing`, `completed`, `failed`) survive. Skipped (as a `skipIf` test) unless
 * TEST_DATABASE_URL is set.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  ABANDONED_IMPORT_RETENTION_HOURS,
  purgeAbandonedStudentImports,
} from "./abandoned-import-sweep";

import type { PurgeLogger } from "./abandoned-import-sweep";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const sweepTest = test.skipIf(!enabled);

let db: Sql | undefined;

/** Schools seeded by this file, so afterAll can remove them and the DB is left as found. */
const seededSchools: string[] = [];

const silentLogger: PurgeLogger = { warn: () => undefined };

const HOUR_MS = 60 * 60 * 1000;
const now = new Date("2026-06-01T00:00:00.000Z");
const old = new Date(now.getTime() - (ABANDONED_IMPORT_RETENTION_HOURS + 24) * HOUR_MS);
const recent = new Date(now.getTime() - HOUR_MS);

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  if (db) {
    await removeSeededSchools();
    await db.end({ timeout: 5 });
  }
});

async function seedSchool(): Promise<{ schoolId: string; userId: string }> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;

    const slug = `imports-sweep-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Import Sweep School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;
    seededSchools.push(schoolId);

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${schoolId}::uuid, ${`${slug}@requestor.local`}, ${`${slug}@requestor.local`})
      RETURNING id
    `;

    return { schoolId, userId: user!.id };
  });
}

/** Remove every row the seeds created, in FK-safe order — app.schools last. */
async function removeSeededSchools(): Promise<void> {
  for (const schoolId of seededSchools) {
    try {
      await db!.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
        await tx`DELETE FROM app.student_imports WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.users WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.schools WHERE id = ${schoolId}::uuid`;
      });
    } catch (error) {
      silentLogger.warn({ school_id: schoolId, error }, "failed to clean up seeded school");
    }
  }
}

async function seedImport(
  schoolId: string,
  userId: string,
  status: "uploaded" | "validated" | "confirmed" | "processing" | "completed" | "failed",
  createdAt: Date,
): Promise<void> {
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.student_imports (
        school_id, uploaded_by, status, file_name, row_count, valid_rows, error_rows,
        rows_data, errors, created_at, updated_at
      ) VALUES (
        ${schoolId}::uuid, ${userId}::uuid, ${status}::app.import_status, 'students.csv',
        1, 1, 0, '[]'::jsonb, '[]'::jsonb, ${createdAt}, ${createdAt}
      )
    `;
  });
}

async function importRowCount(schoolId: string): Promise<number> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.student_imports WHERE school_id = ${schoolId}::uuid
    `;
    return Number(row!.n);
  });
}

describe("abandoned student-import purge sweep", () => {
  sweepTest("purges unconfirmed imports older than retention and keeps every decoy", async () => {
    const { schoolId, userId } = await seedSchool();

    await seedImport(schoolId, userId, "uploaded", old);
    await seedImport(schoolId, userId, "validated", old);
    await seedImport(schoolId, userId, "uploaded", recent);
    await seedImport(schoolId, userId, "confirmed", old);
    await seedImport(schoolId, userId, "processing", old);
    await seedImport(schoolId, userId, "completed", old);
    await seedImport(schoolId, userId, "failed", old);

    const result = await purgeAbandonedStudentImports(db!, now, silentLogger);

    expect(result.failed).toBe(0);
    expect(result.schools).toBeGreaterThanOrEqual(1);
    // 5 decoys survive: the recent unconfirmed upload, plus every status that already committed
    // to (or ran) student creation.
    expect(await importRowCount(schoolId)).toBe(5);
  });
});
