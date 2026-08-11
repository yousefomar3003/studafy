/**
 * State-store adapter for audit-log exports (ST-046x).
 *
 * Maps the canonical lifecycle onto app.audit_export_jobs: native statuses are
 * queued/processing/completed/failed and the artifact key lives in `storage_key`. The table has no
 * signed-url columns — the API presigns the key at fetch time (like attendance) — so this store
 * advertises `persistsSignedUrl: false`. The row is locked FOR UPDATE at claim time and handed back
 * as `record`; the renderer needs the stored `parameters` (the resolved filter), which the queue
 * payload deliberately does not carry.
 */

import { withSystemTenantTx } from "../../db/tenant-tx";

import type { ReportClaim, ReportStateStore } from "./report-state-store";
import type { ReportJobContext, SignedUrlInfo } from "./report-types";
import type { Sql } from "postgres";

/** The audit export row fields the renderer needs, read at claim time. */
export interface AuditReportJobRow {
  parameters: Record<string, unknown>;
  status: string;
}

export const createAuditReportStore = (): ReportStateStore<AuditReportJobRow> => ({
  persistsSignedUrl: false,

  async claim(sql: Sql, context: ReportJobContext): Promise<ReportClaim<AuditReportJobRow>> {
    return withSystemTenantTx(sql, { schoolId: context.schoolId }, async (tx) => {
      const [row] = await tx<AuditReportJobRow[]>`
        SELECT parameters, status::text AS status
        FROM app.audit_export_jobs
        WHERE school_id = ${context.schoolId}::uuid AND id = ${context.jobId}::uuid
        FOR UPDATE
      `;
      if (!row) throw new Error("audit export job does not exist");
      if (row.status === "completed") return { state: "terminal" };
      await tx`
        UPDATE app.audit_export_jobs
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
    _signedUrl?: SignedUrlInfo,
  ): Promise<void> {
    await withSystemTenantTx(sql, { schoolId: context.schoolId }, async (tx) => {
      await tx`
        UPDATE app.audit_export_jobs
        SET status = 'completed', storage_key = ${storageKey}, failure_message = NULL,
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE school_id = ${context.schoolId}::uuid AND id = ${context.jobId}::uuid
      `;
    });
  },

  async fail(sql: Sql, context: ReportJobContext): Promise<void> {
    await withSystemTenantTx(sql, { schoolId: context.schoolId }, async (tx) => {
      await tx`
        UPDATE app.audit_export_jobs
        SET status = 'failed', failure_message = 'Export generation failed',
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE school_id = ${context.schoolId}::uuid AND id = ${context.jobId}::uuid
          AND status <> 'completed'
      `;
    });
  },
});
