/**
 * The expired-report purge sweep (ST-175), against a real database.
 *
 * Seeds schools with old completed report jobs in all three lifecycle tables — attendance
 * (app.report_export_jobs, `reports/` keys), finance (app.finance_report_jobs,
 * `tenant-<schoolId>/reports/` keys) and progress (app.progress_report_jobs, `reports/` keys) —
 * and drives the sweep with an in-memory fake S3 client, so
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

import type { PurgeLogger } from "./report-expiry-sweep";
import type { ReportS3Client } from "./report-types";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const sweepTest = test.skipIf(!enabled);

let db: Sql | undefined;

/** Schools seeded by this file, so afterAll can remove them and the DB is left as found. */
const seededSchools: string[] = [];

const silentLogger: PurgeLogger = {
  warn: () => undefined,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const old = new Date(Date.now() - 10 * DAY_MS);
const recent = new Date(Date.now() - DAY_MS);

beforeAll(async () => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
  // The purge result counts rows across every school, so a completed artifact older than the
  // retention window left behind by an interrupted run would break the exact assertions below.
  // Flush those first: the only rows this can touch are, by definition, past retention.
  await purgeExpiredReports(db, new FakeReportS3(), new Date(), silentLogger);
});

afterAll(async () => {
  if (db) {
    await removeSeededSchools();
    await db.end({ timeout: 5 });
  }
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

/**
 * Remove every row the seeds created, in FK-safe order. app.schools is referenced with
 * ON DELETE RESTRICT by most children, so the school itself is deleted last. Best-effort: a school
 * left behind by a crashed run only feeds the beforeAll purge, which keeps the counters exact.
 */
async function removeSeededSchools(): Promise<void> {
  for (const schoolId of seededSchools) {
    try {
      await db!.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
        await tx`DELETE FROM app.progress_report_jobs WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.finance_report_jobs WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.report_export_jobs WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.terms WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.academic_years WHERE school_id = ${schoolId}::uuid`;
        const students = await tx<{ id: string }[]>`
          SELECT id FROM app.students WHERE school_id = ${schoolId}::uuid
        `;
        for (const student of students) {
          await tx`DELETE FROM app.students WHERE id = ${student.id}::uuid`;
        }
        await tx`DELETE FROM app.users WHERE school_id = ${schoolId}::uuid`;
        await tx`DELETE FROM app.schools WHERE id = ${schoolId}::uuid`;
      });
    } catch (error) {
      silentLogger.warn({ school_id: schoolId, error }, "failed to clean up seeded school");
    }
  }
}

/**
 * Create the minimal academic structure a progress job requires: an active academic year, a term
 * within it, and an enrolled student. Progress jobs are normalized on student/term/year, unlike the
 * free-form report_export_jobs rows.
 */
async function ensureAcademicFixture(
  schoolId: string,
  userId: string,
): Promise<{ studentId: string; termId: string; academicYearId: string }> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const suffix = crypto.randomUUID().slice(0, 6);
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${`SW${suffix}`}, 'Sweep Year', '2026-01-01'::date,
        '2026-12-31'::date, 'active')
      RETURNING id
    `;
    const yearId = year!.id;

    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${yearId}::uuid, ${`SWT${suffix}`}, 'Sweep Term', 1,
        '2026-03-01'::date, '2026-06-30'::date, 'active')
      RETURNING id
    `;

    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students
        (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${userId}::uuid, ${`SW-ADM-${suffix}`}, 'Sweep', 'Student',
        'enrolled')
      RETURNING id
    `;

    return { studentId: student!.id, termId: term!.id, academicYearId: yearId };
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

/**
 * Insert a progress job row shaped to pass ck_progress_report_jobs_terminal_state: completed rows
 * carry a storage key and completed_at, failed rows an error message and completed_at, and
 * pending/processing rows neither.
 */
async function seedProgressJob(
  schoolId: string,
  fixture: { studentId: string; termId: string; academicYearId: string },
  userId: string,
  createdAt: Date,
  status: "pending" | "processing" | "completed" | "failed",
  storageKey: string | null = null,
): Promise<void> {
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      INSERT INTO app.progress_report_jobs (
        school_id, requested_by_user_id, student_id, academic_term_id, academic_year_id, status,
        storage_key, error_message, created_at, completed_at
      ) VALUES (
        ${schoolId}::uuid, ${userId}::uuid, ${fixture.studentId}::uuid, ${fixture.termId}::uuid,
        ${fixture.academicYearId}::uuid, ${status}, ${storageKey},
        ${status === "failed" ? "purged" : null}, ${createdAt},
        ${status === "completed" || status === "failed" ? createdAt : null}
      )
    `;
  });
}

async function progressRowCount(schoolId: string): Promise<number> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.progress_report_jobs WHERE school_id = ${schoolId}::uuid
    `;
    return Number(row!.n);
  });
}

async function attendanceRowCount(schoolId: string): Promise<number> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.report_export_jobs WHERE school_id = ${schoolId}::uuid
    `;
    return Number(row!.n);
  });
}

async function financeRowCount(schoolId: string): Promise<number> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.finance_report_jobs WHERE school_id = ${schoolId}::uuid
    `;
    return Number(row!.n);
  });
}

describe("expired report purge sweep", () => {
  sweepTest("purges completed artifacts older than retention and keeps every decoy", async () => {
    const { schoolId, userId } = await seedSchool();
    const academic = await ensureAcademicFixture(schoolId, userId);

    const oldAttendanceKey = `reports/${schoolId}/attendance-old.xlsx`;
    const recentAttendanceKey = `reports/${schoolId}/attendance-recent.xlsx`;
    const oldFinanceKey = `tenant-${schoolId}/reports/2026/finance-old.csv`;
    const recentFinanceKey = `tenant-${schoolId}/reports/2026/finance-recent.csv`;
    const oldProgressKey = `reports/${schoolId}/progress-old.pdf`;
    const recentProgressKey = `reports/${schoolId}/progress-recent.pdf`;

    await seedAttendanceJob(schoolId, userId, old, "completed", oldAttendanceKey);
    await seedAttendanceJob(schoolId, userId, recent, "completed", recentAttendanceKey);
    await seedAttendanceJob(schoolId, userId, old, "processing");
    await seedFinanceJob(schoolId, userId, old, "completed", oldFinanceKey);
    await seedFinanceJob(schoolId, userId, recent, "completed", recentFinanceKey);
    await seedFinanceJob(schoolId, userId, old, "failed");
    await seedProgressJob(schoolId, academic, userId, old, "completed", oldProgressKey);
    await seedProgressJob(schoolId, academic, userId, recent, "completed", recentProgressKey);
    await seedProgressJob(schoolId, academic, userId, old, "processing");

    const s3 = new FakeReportS3();
    const result = await purgeExpiredReports(db!, s3, new Date(), silentLogger);

    expect(result.attendanceRemoved).toBe(1);
    expect(result.financeRemoved).toBe(1);
    expect(result.progressRemoved).toBe(1);
    expect(result.failed).toBe(0);
    expect(s3.removed.sort()).toEqual([oldAttendanceKey, oldFinanceKey, oldProgressKey].sort());

    // All tables keep the decoys: recent completed, and old rows that are not completed.
    expect(await attendanceRowCount(schoolId)).toBe(2);
    expect(await financeRowCount(schoolId)).toBe(2);
    expect(await progressRowCount(schoolId)).toBe(2);
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
