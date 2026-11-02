/**
 * State-store adapter for progress reports (ST-176).
 *
 * Maps the canonical lifecycle onto app.progress_report_jobs: native statuses are
 * pending/processing/completed/failed and the artifact key lives in `storage_key`. Completed rows
 * are terminal (a duplicate job delivery skips); every other status is claimable. The row is
 * locked FOR UPDATE so two deliveries of the same job cannot both render.
 */

import { withSystemTenantTx } from "../../db/tenant-tx";

import type { ReportClaim, ReportStateStore } from "./report-state-store";
import type { ReportJobContext, SignedUrlInfo } from "./report-types";
import type { Sql } from "postgres";

export const createProgressReportStore = (): ReportStateStore => ({
  persistsSignedUrl: false,

  async claim(sql: Sql, context: ReportJobContext): Promise<ReportClaim> {
    return withSystemTenantTx(sql, { schoolId: context.schoolId }, async (tx) => {
      const [row] = await tx<{ status: string }[]>`
        SELECT status::text AS status
        FROM app.progress_report_jobs
        WHERE school_id = ${context.schoolId} AND id = ${context.jobId}
        FOR UPDATE
      `;
      if (!row) throw new Error("progress report job does not exist");
      if (row.status === "completed") return { state: "terminal" };
      await tx`
        UPDATE app.progress_report_jobs
        SET status = 'processing', storage_key = NULL, error_message = NULL, completed_at = NULL
        WHERE school_id = ${context.schoolId} AND id = ${context.jobId}
      `;
      return { state: "new" };
    });
  },

  async complete(
    sql: Sql,
    context: ReportJobContext,
    storageKey: string,
    _signedUrl?: SignedUrlInfo,
  ): Promise<void> {
    await withSystemTenantTx(sql, { schoolId: context.schoolId }, async (tx) => {
      await tx`
        UPDATE app.progress_report_jobs
        SET status = 'completed',
            storage_key = ${storageKey},
            error_message = NULL,
            completed_at = CURRENT_TIMESTAMP
        WHERE school_id = ${context.schoolId} AND id = ${context.jobId}
      `;
    });
  },

  async fail(sql: Sql, context: ReportJobContext): Promise<void> {
    await withSystemTenantTx(sql, { schoolId: context.schoolId }, async (tx) => {
      await tx`
        UPDATE app.progress_report_jobs
        SET status = 'failed',
            storage_key = NULL,
            error_message = 'Progress report generation failed',
            completed_at = CURRENT_TIMESTAMP
        WHERE school_id = ${context.schoolId} AND id = ${context.jobId}
          AND status <> 'completed'
      `;
    });
  },
});
