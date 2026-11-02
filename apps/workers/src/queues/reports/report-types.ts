/**
 * Report type definitions and shared contracts for the async report framework (ST-175).
 *
 * The framework's job is to make a "report type" a data object: parse its payload, claim its
 * lifecycle row, render an artifact, store it, and record the outcome — with the database
 * specifics of each report table hidden behind narrow ports. Everything a report type needs to
 * describe itself lives here; the runner, registry and sweep in this directory drive them.
 */

import type { ReportStateStore } from "./report-state-store";
import type { Sql } from "postgres";
import type { z } from "zod";

/**
 * The framework's internal lifecycle contract.
 *
 * Each report table has its own native enum — app.report_export_status is
 * pending/processing/completed/failed, app.finance_report_status is queued/processing/completed/
 * failed — and the state-store adapters map those onto the canonical statuses below so the runner
 * is agnostic to which table a report lives in. "ready" is the canonical name for the completed,
 * downloadable state.
 */
export type ReportStatus = "queued" | "processing" | "ready" | "failed";

/** The tenant-scoped identity every report job payload carries. */
export interface ReportJobContext {
  jobId: string;
  schoolId: string;
  requestedByUserId: string;
}

/**
 * Everything a report processor needs to reach the database and object storage. Kept in one shape
 * so the registry can build it once per job and hand it to the runner.
 */
export interface ReportRunnerConfig {
  primaryDatabaseUrl: string;
  readDatabaseUrl?: string;
  databaseCaCert?: string;
  s3Region?: string;
  s3Endpoint?: string;
  bucket?: string;
  erpnextBaseUrl?: string;
  erpnextApiKey?: string;
}

/** What a report processor resolves to for BullMQ. */
export interface ReportRunResult {
  processed: boolean;
  storageKey?: string;
  bytes?: number;
  reason?: string;
}

/**
 * The object-storage port a report renders into. Narrow so tests can hand the runner an in-memory
 * fake, mirroring the scan and storage-quota S3 adapters.
 */
export interface ReportS3Client {
  put(
    key: string,
    artifact: Uint8Array,
    options: { contentType: string; contentDisposition: string },
  ): Promise<void>;
  remove(key: string): Promise<void>;
  presignGet(key: string): Promise<string>;
}

/** A signed URL a store persists so the API can serve it without a live S3 round-trip. */
export interface SignedUrlInfo {
  url: string;
  expiresAt: Date;
}

/**
 * The context a report renderer receives. `record` is the opaque lifecycle row the store read at
 * claim time — the finance store hands its renderer the job row (report type, format, parameters)
 * because those are only known from the database, not from the queue payload.
 */
export interface ReportRenderDeps<TData, TRecord = unknown> {
  primary: Sql;
  replica?: Sql;
  context: ReportJobContext;
  data: TData;
  record?: TRecord;
  now: Date;
  config: ReportRunnerConfig;
}

/**
 * One entry in the report type registry. A report type is fully described by its payload schema
 * and four behaviours; the runner sequences them and owns the shared failure/retry lifecycle.
 *
 * The functional fields are declared as methods (not function-typed properties) on purpose:
 * TypeScript checks method parameters bivariantly, which lets the registry hold definitions for
 * different report tables side by side under the erased `ReportTypeDefinition<ReportJobContext>`
 * type without a cast per entry.
 */
export interface ReportTypeDefinition<
  TData extends ReportJobContext = ReportJobContext,
  TRecord = unknown,
> {
  jobName: string;
  schema: z.ZodType<TData>;
  store: ReportStateStore<TRecord>;
  render(deps: ReportRenderDeps<TData, TRecord>): Promise<Uint8Array>;
  storageKey(data: TData, record?: TRecord): string;
  contentType(data: TData, record?: TRecord): string;
  contentDisposition(data: TData, record?: TRecord): string;
}
