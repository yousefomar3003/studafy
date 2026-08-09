/**
 * Expired-report purge sweep (ST-175).
 *
 * The app-files bucket's lifecycle rule expires `reports/<schoolId>/...` objects after 7 days, but
 * it only matches that prefix — the legacy finance keys under `tenant-<schoolId>/reports/` are
 * invisible to it (see docs/runbooks/storage-conventions.md "Known gaps"). This scheduled sweep is
 * the DB-driven closure for both: once a day it finds completed job rows older than the 7-day
 * retention window, deletes their objects, and removes the rows so the API reports a clean 404
 * instead of a URL that 403s on download.
 *
 * Each school runs in its own transaction, mirroring the dunning, seat and storage-quota sweeps:
 * a database or S3 error rolls that school's step back and is counted for ops telemetry while the
 * schools after it proceed. The pipeline is crash-safe because every step is idempotent — a school
 * that failed mid-way is simply selected again next run (S3 DeleteObject on a missing key is a
 * no-op, and the row deletes match the same `completed AND old AND key IS NOT NULL` predicate).
 */

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { ReportS3Client } from "./report-types";
import type { Sql, TransactionSql } from "postgres";

/** Report artifacts are retained for 7 days, matching the bucket lifecycle rule and BullMQ retention. */
export const REPORT_RETENTION_DAYS = 7;

export interface PurgeExpiredReportsResult {
  schools: number;
  /** Artifacts removed from app.report_export_jobs (attendance, `reports/` prefix). */
  attendanceRemoved: number;
  /** Artifacts removed from app.finance_report_jobs (finance, `tenant-<schoolId>/reports/` prefix). */
  financeRemoved: number;
  /** Schools whose purge aborted (S3 or database error) — ops telemetry, job continues. */
  failed: number;
}

export interface PurgeLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

const silentLogger: PurgeLogger = { warn: () => undefined };

export async function purgeExpiredReports(
  sql: Sql,
  s3: ReportS3Client,
  now: Date,
  log: PurgeLogger = silentLogger,
): Promise<PurgeExpiredReportsResult> {
  const cutoff = new Date(now.getTime() - REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const schoolIds = await loadSchoolIds(sql);
  const result: PurgeExpiredReportsResult = {
    schools: schoolIds.length,
    attendanceRemoved: 0,
    financeRemoved: 0,
    failed: 0,
  };

  for (const schoolId of schoolIds) {
    try {
      const keys = await collectExpiredKeys(sql, schoolId, cutoff);
      for (const key of [...keys.attendance, ...keys.finance]) {
        await s3.remove(key);
      }
      await deleteExpiredRows(sql, schoolId, cutoff);
      result.attendanceRemoved += keys.attendance.length;
      result.financeRemoved += keys.finance.length;
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "expired report purge failed for school; rolled back and skipped",
      );
    }
  }

  return result;
}

async function collectExpiredKeys(
  sql: Sql,
  schoolId: string,
  cutoff: Date,
): Promise<{ attendance: string[]; finance: string[] }> {
  return withSystemTenantTx(sql, { schoolId }, (tx) => selectExpiredKeys(tx, cutoff));
}

async function deleteExpiredRows(sql: Sql, schoolId: string, cutoff: Date): Promise<void> {
  await withSystemTenantTx(sql, { schoolId }, async (tx) => {
    await tx`
      DELETE FROM app.report_export_jobs
      WHERE school_id = current_setting('app.school_id')::uuid
        AND status = 'completed' AND storage_key IS NOT NULL
        AND created_at < ${cutoff}
    `;
    await tx`
      DELETE FROM app.finance_report_jobs
      WHERE school_id = current_setting('app.school_id')::uuid
        AND status = 'completed' AND object_key IS NOT NULL
        AND created_at < ${cutoff}
    `;
  });
}

async function selectExpiredKeys(
  tx: TransactionSql,
  cutoff: Date,
): Promise<{ attendance: string[]; finance: string[] }> {
  const attendance = await tx<{ storage_key: string }[]>`
    SELECT storage_key
    FROM app.report_export_jobs
    WHERE school_id = current_setting('app.school_id')::uuid
      AND status = 'completed' AND storage_key IS NOT NULL
      AND created_at < ${cutoff}
  `;
  const finance = await tx<{ object_key: string }[]>`
    SELECT object_key
    FROM app.finance_report_jobs
    WHERE school_id = current_setting('app.school_id')::uuid
      AND status = 'completed' AND object_key IS NOT NULL
      AND created_at < ${cutoff}
  `;
  return {
    attendance: attendance.map((row) => row.storage_key),
    finance: finance.map((row) => row.object_key),
  };
}
