/**
 * The expired-report purge sweep (ST-175), against a real database.
 *
 * Seeds schools with old completed report jobs in both lifecycle tables — attendance
 * (app.report_export_jobs, `reports/` keys) and finance (app.finance_report_jobs,
 * `tenant-<schoolId>/reports/` keys) — and drives the sweep with an in-memory fake S3 client, so
 * no network is touched and every removed key is deterministic. The acceptance the tests prove:
 * only completed artifacts older than the 7-day retention are purged (recent rows, non-terminal
 * rows and rows without a key are decoys that survive), the DB row disappears so the API reports a
 * clean 404, and a school whose S3 removal fails keeps its rows without stopping the schools after
 * it. Skipped (as `skipIf` tests) unless TEST_DATABASE_URL is set.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { purgeExpiredReports } from "./report-expiry-sweep";

import type { ReportS3Client } from "./report-types";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const sweepTest = test.skipIf(!enabled);

let db: Sql | undefined;

const silentLogger = {
  warn: () => undefined,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const old = new Date(Date.now() - 10 * DAY_MS);
const recent = new Date(Date.now() - DAY_MS);

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

class FakeReportS3 implements ReportS3Client {
  removed: string[] = [];
  /** Keys whose removal should throw (the "S3 unavailable" failure case). */
  failFor = new Set<string>();

  async put(): Promise<void> {
    throw new Error("not used by the sweep");
  }

  async remove(key: string): Promise<void> {
    if (this.failFor.has(key)) throw new Error("s3 unavailable");
    this.removed.push(key);
  }

  async presignGet(): Promise<string> {
    throw new Error("not used by the sweep");
  }
}

async function seedSchool(): Promise<{ schoolId: string; userId: string }> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;

    const slug = `reports-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Report Sweep School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${schoolId}::uuid, ${`${slug}@requestor.local`}, ${`${slug}@requestor.local`})
      RETURNING id
    `;

    return { schoolId, userId: user!.id };
  });
}

/**
 * Insert an attendance job row shaped to pass ck_report_export_jobs_terminal_state: completed rows
 * carry a storage key and completed_at, failed rows an error message and completed_at, and
 * pending/processing rows neither.
 */
async function seedAttendanceJob(
  schoolId: string,
  userId: string,
  createdAt: Date,
  status: "pending" | "processing" | "completed" | "failed",
  storageKey: string | null = null,
): Promise<void> {
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.report_export_jobs (
        school_id, requested_by_user_id, file_format, status,
        storage_key, error_message, created_at, completed_at
      ) VALUES (
        ${schoolId}::uuid, ${userId}::uuid, 'xlsx', ${status},
        ${storageKey}, ${status === "failed" ? "purged" : null}, ${createdAt},
        ${status === "completed" || status === "failed" ? createdAt : null}
      )
    `;
  });
}

/**
 * Insert a finance job row shaped to pass ck_finance_report_jobs_terminal_state: completed rows
 * carry object_key, signed_url, signed_url_expires_at and completed_at; failed rows a failure
 * message and completed_at; queued/processing rows none of these.
 */
async function seedFinanceJob(
  schoolId: string,
  userId: string,
  createdAt: Date,
  status: "queued" | "processing" | "completed" | "failed",
  objectKey: string | null = null,
): Promise<void> {
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.finance_report_jobs (
        school_id, requested_by_user_id, report_type, file_format, status,
        object_key, signed_url, signed_url_expires_at, failure_message, parameters,
        created_at, completed_at
      ) VALUES (
        ${schoolId}::uuid, ${userId}::uuid, 'ar_aging', 'csv', ${status},
        ${objectKey}, ${status === "completed" ? "https://signed.example/old.csv" : null},
        ${status === "completed" ? new Date(createdAt.getTime() + DAY_MS) : null},
        ${status === "failed" ? "purged" : null}, '{}'::jsonb,
        ${createdAt}, ${status === "completed" || status === "failed" ? createdAt : null}
      )
    `;
  });
}

async function attendanceRowCount(schoolId: string): Promise<number> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [row] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.report_export_jobs WHERE school_id = ${schoolId}::uuid
    `;
    return Number(row!.n);
  });
}

async function financeRowCount(schoolId: string): Promise<number> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [row] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.finance_report_jobs WHERE school_id = ${schoolId}::uuid
    `;
    return Number(row!.n);
  });
}

describe("expired report purge sweep", () => {
  sweepTest("purges completed artifacts older than retention and keeps every decoy", async () => {
    const { schoolId, userId } = await seedSchool();

    const oldAttendanceKey = `reports/${schoolId}/attendance-old.xlsx`;
    const recentAttendanceKey = `reports/${schoolId}/attendance-recent.xlsx`;
    const oldFinanceKey = `tenant-${schoolId}/reports/2026/finance-old.csv`;
    const recentFinanceKey = `tenant-${schoolId}/reports/2026/finance-recent.csv`;

    await seedAttendanceJob(schoolId, userId, old, "completed", oldAttendanceKey);
    await seedAttendanceJob(schoolId, userId, recent, "completed", recentAttendanceKey);
    await seedAttendanceJob(schoolId, userId, old, "processing");
    await seedFinanceJob(schoolId, userId, old, "completed", oldFinanceKey);
    await seedFinanceJob(schoolId, userId, recent, "completed", recentFinanceKey);
    await seedFinanceJob(schoolId, userId, old, "failed");

    const s3 = new FakeReportS3();
    const result = await purgeExpiredReports(db!, s3, new Date(), silentLogger);

    expect(result.attendanceRemoved).toBe(1);
    expect(result.financeRemoved).toBe(1);
    expect(result.failed).toBe(0);
    expect(s3.removed.sort()).toEqual([oldAttendanceKey, oldFinanceKey].sort());

    // Both tables keep the decoys: recent completed, and old rows that are not completed.
    expect(await attendanceRowCount(schoolId)).toBe(2);
    expect(await financeRowCount(schoolId)).toBe(2);
  });

  sweepTest(
    "a school whose S3 removal fails keeps its rows without stopping the schools after it",
    async () => {
      const first = await seedSchool();
      const second = await seedSchool();
      const firstKey = `reports/${first.schoolId}/attendance-first.xlsx`;
      const secondKey = `reports/${second.schoolId}/attendance-second.xlsx`;
      await seedAttendanceJob(first.schoolId, first.userId, old, "completed", firstKey);
      await seedAttendanceJob(second.schoolId, second.userId, old, "completed", secondKey);

      const s3 = new FakeReportS3();
      s3.failFor.add(firstKey);

      const result = await purgeExpiredReports(db!, s3, new Date(), silentLogger);

      expect(result.failed).toBe(1);
      expect(result.attendanceRemoved).toBe(1);
      expect(result.schools).toBeGreaterThanOrEqual(2);
      expect(s3.removed).toEqual([secondKey]);

      // The failed school rolled back (its rows still exist); the next school was fully purged.
      expect(await attendanceRowCount(first.schoolId)).toBe(1);
      expect(await attendanceRowCount(second.schoolId)).toBe(0);
    },
  );
});
