/**
 * State-store adapter for finance exports (ST-175).
 *
 * Maps the canonical lifecycle onto app.finance_report_jobs: native statuses are
 * queued/processing/completed/failed, the artifact key lives in `object_key`, and the signed URL
 * (24h TTL) is persisted in `signed_url`/`signed_url_expires_at` — so this store advertises
 * `persistsSignedUrl`. The row is locked FOR UPDATE at claim time and handed back as `record`,
 * because the renderer and the storage key both need fields that are only known from the database
 * (report type, file format, parameters, created_at).
 */

import { withSystemTenantTx } from "../../db/tenant-tx";

import type { ReportClaim, ReportStateStore } from "./report-state-store";
import type { ReportJobContext, SignedUrlInfo } from "./report-types";
import type { FinanceFileFormat, FinanceReportType } from "@studafy/finance-reporting";
import type { Sql } from "postgres";

/** The finance job row fields the renderer and storage key need, read at claim time. */
export interface FinanceReportJobRow {
  report_type: FinanceReportType;
  file_format: FinanceFileFormat;
  parameters: Record<string, unknown>;
  status: string;
  created_at: Date;
}

export const createFinanceReportStore = (): ReportStateStore<FinanceReportJobRow> => ({
  persistsSignedUrl: true,

  async claim(sql: Sql, context: ReportJobContext): Promise<ReportClaim<FinanceReportJobRow>> {
    return withSystemTenantTx(sql, { schoolId: context.schoolId }, async (tx) => {
      const [row] = await tx<FinanceReportJobRow[]>`
        SELECT report_type::text AS report_type, file_format, parameters, status::text AS status,
               created_at
        FROM app.finance_report_jobs
        WHERE school_id = ${context.schoolId}::uuid AND id = ${context.jobId}::uuid
        FOR UPDATE
      `;
      if (!row) throw new Error("finance report job does not exist");
      if (row.status === "completed") return { state: "terminal" };
      await tx`
        UPDATE app.finance_report_jobs
        SET status = 'processing', started_at = COALESCE(started_at, clock_timestamp()),
            failure_message = NULL, updated_at = clock_timestamp()
        WHERE school_id = ${context.schoolId}::uuid AND id = ${context.jobId}::uuid
      `;
      return { state: "new", record: row };
    });
  },

  async complete(
    sql: Sql,
    context: ReportJobContext,
    storageKey: string,
    signedUrl?: SignedUrlInfo,
  ): Promise<void> {
    await withSystemTenantTx(sql, { schoolId: context.schoolId }, async (tx) => {
      await tx`
        UPDATE app.finance_report_jobs
        SET status = 'completed', object_key = ${storageKey},
            signed_url = ${signedUrl?.url ?? null},
            signed_url_expires_at = ${signedUrl?.expiresAt ?? null},
            failure_message = NULL,
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE school_id = ${context.schoolId}::uuid AND id = ${context.jobId}::uuid
      `;
    });
  },

  async fail(sql: Sql, context: ReportJobContext): Promise<void> {
    await withSystemTenantTx(sql, { schoolId: context.schoolId }, async (tx) => {
      await tx`
        UPDATE app.finance_report_jobs
        SET status = 'failed', failure_message = 'Export generation failed',
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE school_id = ${context.schoolId}::uuid AND id = ${context.jobId}::uuid
          AND status <> 'completed'
      `;
    });
  },
});
