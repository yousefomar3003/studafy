/**
 * Malware scan of a user upload other than a study material (file-scan queue, `scan-upload` job;
 * security finding F-14).
 *
 * The same guarantee the material scan gives (scan-material.worker.ts), for every other file one
 * person uploads and another downloads: submission and assignment files, question pictures, message
 * images, record documents, expense and license receipts, school application proofs and student
 * import files. Each lives on its own table with an `app.upload_scan_status` column (000192); the
 * API sets it to `scanning` in the write that stores the key and enqueues this job once that write
 * commits. The worker streams the object into clamd and applies the verdict:
 *
 *   clean      — status -> `clean`; the file is now served.
 *   infected   — the object is copied to `quarantine/<same path>`, the `permanent/` copy deleted,
 *                status -> `quarantined`, and the verdict logged as an alert. Never served.
 *   scan error — the job throws and BullMQ retries; on the terminal attempt the onFailed hook flips
 *                the row to `failed`. Fail closed: no verdict, no download.
 *
 * ## The claim is the row's status and key
 *
 * The job carries the storage key, not a row id, and every write is guarded by
 * `key = <job key> AND status IN ('scanning', 'unscanned')`. A duplicate job therefore finds the row
 * already decided and skips; a stale one (the record document was replaced, the question set was
 * re-saved under new row ids) either finds no row with that key or a row already scanned. Keying by
 * the object rather than the row is also what lets question pictures be scanned: a question set is
 * rewritten on every save, but a kept picture keeps its key and its status.
 *
 * `unscanned` (a file uploaded before 000192) is accepted as well, so a backfill is just enqueueing
 * jobs for those rows: an infected one is quarantined like a new upload. A backfill scan that fails
 * leaves the row `unscanned` rather than `failed` — it was served before and the failure is ours.
 *
 * ## Crash recovery
 *
 * Exactly the material worker's order and reasoning: copy -> delete permanent -> flip. A run that
 * dies between delete and flip is retried against the quarantine copy, which holds the same bytes.
 */

import { JOB_NAMES, UPLOAD_SCAN_TARGETS, type UploadScanTarget } from "@studafy/constants";
import { z } from "zod";

import { leaseDatabase } from "../../db/pool";
import { withSystemTenantTx, withSystemTx } from "../../db/tenant-tx";
import {
  isTerminalFailure,
  type DeadLetterLogger,
  type FailedHandler,
  type FailedJobLike,
} from "../notifications/dead-letter";

import { ClamdScanError, type ClamdConfig } from "./clamd";
import { objectExists, quarantineKeyOf, scanObject } from "./scan-material.worker";

import type { ScanS3Client } from "./s3";
import type { DatabaseSource } from "../../db/pool";
import type { Job } from "bullmq";
import type { Sql, TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** Where one upload target's file and scan status live. */
interface TargetSpec {
  /** Table in the app schema. */
  table: string;
  keyColumn: string;
  statusColumn: string;
  /** `global` for app.school_applications, which has no school; everything else is per school. */
  scope: "school" | "global";
}

/**
 * The closed registry the job's target resolves through. Identifiers in the SQL below come only from
 * here, never from job data.
 */
export const UPLOAD_SCAN_TARGET_SPECS: Readonly<Record<UploadScanTarget, TargetSpec>> = {
  submission_attachment: {
    table: "submission_attachments",
    keyColumn: "storage_key",
    statusColumn: "scan_status",
    scope: "school",
  },
  assignment_attachment: {
    table: "assignment_attachments",
    keyColumn: "storage_key",
    statusColumn: "scan_status",
    scope: "school",
  },
  question_image: {
    table: "assignment_questions",
    keyColumn: "image_storage_key",
    statusColumn: "image_scan_status",
    scope: "school",
  },
  message_attachment: {
    table: "message_attachments",
    keyColumn: "storage_key",
    statusColumn: "scan_status",
    scope: "school",
  },
  record_document: {
    table: "record_documents",
    keyColumn: "storage_key",
    statusColumn: "scan_status",
    scope: "school",
  },
  expense_attachment: {
    table: "expense_cache",
    keyColumn: "attachment_storage_key",
    statusColumn: "attachment_scan_status",
    scope: "school",
  },
  license_receipt: {
    table: "license_payment_receipts",
    keyColumn: "storage_key",
    statusColumn: "scan_status",
    scope: "school",
  },
  school_application_proof: {
    table: "school_applications",
    keyColumn: "proof_storage_key",
    statusColumn: "proof_scan_status",
    scope: "global",
  },
  import_source: {
    table: "student_imports",
    keyColumn: "source_storage_key",
    statusColumn: "source_scan_status",
    scope: "school",
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const scanUploadJobDataSchema = z
  .object({
    target: z.enum(UPLOAD_SCAN_TARGETS),
    schoolId: z.string().uuid().nullable(),
    storageKey: z.string().min(1),
  })
  .refine(
    (data) =>
      (UPLOAD_SCAN_TARGET_SPECS[data.target].scope === "global") === (data.schoolId === null),
    { message: "schoolId must be set exactly for per-school targets" },
  );

export type ScanUploadJobData = z.infer<typeof scanUploadJobDataSchema>;

export interface ScanUploadConfig {
  /** Used only when `sql` is absent: a dedicated pool is opened for this job (tests). */
  databaseUrl: string;
  databaseCaCert?: string;
  /** The process-wide pool (db/pool.ts). Borrowed, never ended here. */
  sql?: Sql;
  s3: ScanS3Client | null;
  bucket?: string;
  clamd: ClamdConfig;
  /** Where an infected verdict is reported. The log line is the alert. */
  log?: Pick<DeadLetterLogger, "error">;
}

export type ScanUploadResult =
  | { processed: true; outcome: "clean" | "quarantined" | "skipped" | "rejected" }
  | { processed: false; reason: string };

/** The statuses a scan may still decide. */
const UNDECIDED = ["scanning", "unscanned"] as const;

/**
 * The prefix every key of this target must live under: the job's own school, or the reserved
 * school-applications segment. The worker copies and deletes objects, so it must never act on a key
 * outside the tenant whose row holds it, whatever a row was made to point at.
 */
function ownPrefix(spec: TargetSpec, data: ScanUploadJobData): string {
  return spec.scope === "global" ? "permanent/school-applications/" : `permanent/${data.schoolId}/`;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function inScope<T>(
  sql: Sql,
  spec: TargetSpec,
  schoolId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return spec.scope === "global"
    ? withSystemTx(sql, fn)
    : withSystemTenantTx(sql, { schoolId: schoolId! }, fn);
}

function rowFilter(tx: TransactionSql, spec: TargetSpec, data: ScanUploadJobData) {
  return spec.scope === "global"
    ? tx`${tx(spec.keyColumn)} = ${data.storageKey}`
    : tx`${tx(spec.keyColumn)} = ${data.storageKey} AND school_id = ${data.schoolId}::uuid`;
}

async function readRow(
  tx: TransactionSql,
  spec: TargetSpec,
  data: ScanUploadJobData,
): Promise<{ status: string } | undefined> {
  const [row] = await tx<{ status: string }[]>`
    SELECT ${tx(spec.statusColumn)}::text AS status
    FROM ${tx(`app.${spec.table}`)}
    WHERE ${rowFilter(tx, spec, data)}
    LIMIT 1
  `;
  return row;
}

/** Flip every undecided row holding this key to `to`. Returns how many rows it decided. */
async function decide(
  tx: TransactionSql,
  spec: TargetSpec,
  data: ScanUploadJobData,
  to: "clean" | "quarantined" | "failed",
  from: readonly string[] = UNDECIDED,
): Promise<number> {
  const result = await tx`
    UPDATE ${tx(`app.${spec.table}`)}
    SET ${tx(spec.statusColumn)} = ${to}::app.upload_scan_status
    WHERE ${rowFilter(tx, spec, data)}
      AND ${tx(spec.statusColumn)}::text IN ${tx(from as string[])}
  `;
  return result.count;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Scan one upload. `config` is injected, as for processMaterialScan, so tests run it against a
 * disposable database, a fake clamd and an in-memory S3.
 */
export async function processUploadScan(
  job: Pick<Job, "data">,
  config: ScanUploadConfig,
): Promise<ScanUploadResult> {
  const parsed = scanUploadJobDataSchema.safeParse(job.data);
  if (!parsed.success) return { processed: false, reason: "invalid job data" };
  const data = parsed.data;
  const spec = UPLOAD_SCAN_TARGET_SPECS[data.target];

  if (!config.s3 || !config.bucket) throw new Error("scan storage is not configured");
  if (!config.clamd.host) throw new Error("clamd is not configured");

  const sqlLease = leaseDatabase(config.sql ?? config.databaseUrl, {
    databaseCaCert: config.databaseCaCert,
  });
  const sql = sqlLease.sql;
  const s3 = config.s3;
  const bucket = config.bucket;

  try {
    const row = await inScope(sql, spec, data.schoolId, (tx) => readRow(tx, spec, data));

    // No row holds this key any more (deleted, replaced, re-saved), or a prior run already decided
    // it. Either way the claim is lost and there is nothing to do.
    if (!row || !(UNDECIDED as readonly string[]).includes(row.status)) {
      return { processed: true, outcome: "skipped" };
    }

    // A key outside the owning tenant's prefix is never scanned, copied or deleted, and never
    // served: the row fails closed.
    if (!data.storageKey.startsWith(ownPrefix(spec, data))) {
      await inScope(sql, spec, data.schoolId, (tx) =>
        decide(tx, spec, data, "failed", ["scanning"]),
      );
      config.log?.error(
        { event: "upload_scan_foreign_key", target: data.target, school_id: data.schoolId },
        "an upload row points outside its school's storage prefix; it is marked failed and never served",
      );
      return { processed: true, outcome: "rejected" };
    }

    const quarantineKey = quarantineKeyOf(data.storageKey);
    if (!quarantineKey) throw new Error("upload storage key is not under permanent/");

    let verdict = await scanObject(s3, bucket, data.storageKey, config.clamd);
    let recoveredFromQuarantine = false;

    if (verdict === "missing") {
      // A prior attempt copied and deleted the permanent object but died before the flip committed.
      if (!(await objectExists(s3, bucket, quarantineKey))) {
        throw new Error("upload object is missing and has no quarantine copy");
      }
      verdict = await scanObject(s3, bucket, quarantineKey, config.clamd);
      if (verdict === "missing") throw new Error("quarantine copy disappeared during retry");
      recoveredFromQuarantine = true;
    }

    if (verdict.kind === "error") {
      // Never fabricate a clean verdict: retry, and fail closed on the terminal attempt.
      throw new ClamdScanError(`clamd scan failed: ${verdict.message}`);
    }

    if (verdict.kind === "clean") {
      // The served copy is gone, so `clean` would advertise a file with nothing behind it.
      if (recoveredFromQuarantine) {
        throw new Error("upload object is missing but its quarantine copy scans clean");
      }
      await inScope(sql, spec, data.schoolId, (tx) => decide(tx, spec, data, "clean"));
      return { processed: true, outcome: "clean" };
    }

    // Infected. Copy -> delete permanent -> flip (see the header).
    if (!recoveredFromQuarantine) {
      await s3.copyObject({
        Bucket: bucket,
        Key: quarantineKey,
        CopySource: `${bucket}/${data.storageKey}`,
      });
      await s3.deleteObject({ Bucket: bucket, Key: data.storageKey });
    }

    await inScope(sql, spec, data.schoolId, (tx) => decide(tx, spec, data, "quarantined"));

    config.log?.error(
      {
        event: "upload_quarantined",
        target: data.target,
        school_id: data.schoolId,
        quarantine_key: quarantineKey,
        virus: verdict.virus,
      },
      "an uploaded file was infected; it was quarantined and is never served",
    );
    return { processed: true, outcome: "quarantined" };
  } finally {
    await sqlLease.release();
  }
}

// ---------------------------------------------------------------------------
// Terminal-failure hook
// ---------------------------------------------------------------------------

/**
 * Fail closed: a `scanning` upload whose scan job exhausted its retries becomes `failed` and is
 * never served. An `unscanned` (pre-000192) file a backfill could not scan stays as it was.
 */
export function uploadScanFailedListener(
  database: DatabaseSource,
  log: DeadLetterLogger,
): FailedHandler {
  return (job, error) => {
    if (!isTerminalFailure(job)) return;
    void handleUploadScanFailure(job, error, database, log).catch((writeError: unknown) => {
      log.error(
        { event: "upload_scan_failure_write_failed", job_id: job.id ?? null, err: writeError },
        "could not record a terminally failed upload scan",
      );
    });
  };
}

async function handleUploadScanFailure(
  job: FailedJobLike,
  error: Error,
  database: DatabaseSource,
  log: DeadLetterLogger,
): Promise<void> {
  const parsed = scanUploadJobDataSchema.safeParse(job.data);
  log.error(
    {
      event: "upload_scan_failed",
      target: parsed.success ? parsed.data.target : null,
      school_id: parsed.success ? parsed.data.schoolId : null,
      job_id: job.id ?? null,
      attempts_made: job.attemptsMade,
      err: { type: error.name, message: error.message, stack: error.stack },
    },
    "upload scan job exhausted its retries; the file is marked failed and never served",
  );
  if (!parsed.success) return;

  const data = parsed.data;
  const spec = UPLOAD_SCAN_TARGET_SPECS[data.target];
  const lease = leaseDatabase(database);
  const sql = lease.sql;
  try {
    await inScope(sql, spec, data.schoolId, (tx) => decide(tx, spec, data, "failed", ["scanning"]));
  } finally {
    await lease.release();
  }
}

/** Whether a file-scan job is a `scan-upload` job (the queue also carries `scan-material`). */
export function isUploadScanJob(job: { name: string } | undefined): boolean {
  return job?.name === JOB_NAMES.SCAN_UPLOAD;
}
