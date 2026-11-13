/**
 * The lifecycle-row port the report runner and its adapters share.
 *
 * Each report table keeps its own status enum and its own "where did the artifact go" columns. The
 * runner should not know any of that; it only needs four operations and one fact
 * (`persistsSignedUrl`). The concrete stores in this directory implement this port against
 * app.report_export_jobs (attendance) and app.finance_report_jobs (finance).
 */

import type { ReportJobContext, SignedUrlInfo } from "./report-types";
import type { Sql } from "postgres";

/**
 * The outcome of `claim`. "terminal" means the job row was already in a terminal state (a
 * duplicate delivery of a completed job) and the runner must skip render. "new" means the row was
 * claimed — locked and flipped to processing — and `record`, when present, is whatever the store
 * read at claim time that the renderer and storage key need.
 */
export type ReportClaim<TRecord = unknown> =
  { state: "new"; record?: TRecord } | { state: "terminal" };

export interface ReportStateStore<TRecord = unknown> {
  /** Whether the runner must persist a signed URL after upload (finance does, attendance does not). */
  readonly persistsSignedUrl: boolean;

  /**
   * Lock the job row (`FOR UPDATE`) and mark it processing. Returns "terminal" when the row is
   * already terminal so a duplicate job delivery is a no-op. Must throw when the row is missing.
   */
  claim(sql: Sql, context: ReportJobContext): Promise<ReportClaim<TRecord>>;

  /** Mark the row completed with the stored artifact's key (and its signed URL, when applicable). */
  complete(
    sql: Sql,
    context: ReportJobContext,
    storageKey: string,
    signedUrl?: SignedUrlInfo,
  ): Promise<void>;

  /**
   * Mark the row failed. Only called by the runner on the final BullMQ attempt; earlier attempts
   * leave the row processing so a later delivery can pick it up.
   */
  fail(sql: Sql, context: ReportJobContext): Promise<void>;
}
