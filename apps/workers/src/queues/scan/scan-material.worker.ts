/**
 * Material malware scan (file-scan queue).
 *
 * Consumes one job per confirmed material. The confirm route flips the material to `scanning` and
 * enqueues this job; the worker streams the object from S3 into clamd and applies the verdict:
 *
 *   clean        — material -> `ready` (the "available" state) and the derivations job is enqueued
 *                  so the thumbnail/preview worker runs on the now-clean object.
 *   infected     — the object is copied to `quarantine/<schoolId>/materials/`, the material is
 *                  flipped to `quarantined`, the uploader is notified, and the `permanent/` copy
 *                  is deleted. The material is never served.
 *   scan error   — the job throws and BullMQ retries. On the terminal attempt the onFailed hook
 *                  flips the material to `failed` and alerts the uploader. Fail closed: no verdict,
 *                  no availability.
 *
 * ## Why the status flip is the claim
 *
 * The worker only touches a material still in `scanning`, and every write is guarded by that
 * status. A retried or duplicated job therefore cannot scan an object twice or notify the uploader
 * twice — whichever run wins the flip, the other becomes a no-op. BullMQ's at-least-once delivery
 * would otherwise make the notification write unsafe.
 *
 * ## Why quarantine copies before the flip, and why a missing object is not an error
 *
 * The order is copy -> delete permanent -> flip. Copying first means the infected bytes are
 * preserved under `quarantine/` even if the process dies next line. Deleting before the flip means
 * the served copy is gone before the state change that makes that fact observable. If a run dies
 * between delete and flip, the retry finds the permanent object gone and re-scans the quarantine
 * copy — the same bytes, the same verdict — then completes the flip. The quarantine copy is the
 * checkpoint that makes that crash window recoverable instead of mis-labelled as a scan failure.
 */

import { DOMAIN_EVENTS, NOTIFICATION_TYPES } from "@studafy/constants";
import postgres from "postgres";
import { z } from "zod";

import { withSystemTenantTx } from "../../db/tenant-tx";
import {
  isTerminalFailure,
  type DeadLetterLogger,
  type FailedHandler,
  type FailedJobLike,
} from "../notifications/dead-letter";

import { ClamdScanError, scanStream, type ClamdConfig, type ScanVerdict } from "./clamd";

import type { ScanS3Client } from "./s3";
import type { Job } from "bullmq";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const scanMaterialJobDataSchema = z.object({
  schoolId: z.string().uuid(),
  materialId: z.string().uuid(),
  storageKey: z.string().min(1),
  uploadedByUserId: z.string().uuid(),
});

export type ScanMaterialJobData = z.infer<typeof scanMaterialJobDataSchema>;

export interface ScanMaterialConfig {
  databaseUrl: string;
  databaseCaCert?: string;
  s3: ScanS3Client | null;
  bucket?: string;
  clamd: ClamdConfig;
  /**
   * Enqueue the `derive-material-previews` job once a material is clean. Injected by the registry so
   * this worker stays free of BullMQ/Redis imports. Required: the scan worker is the derivations
   * queue's only producer, so an absent producer is a configuration error, not a mode.
   */
  enqueueDerivation: (data: { schoolId: string; materialId: string }) => Promise<void>;
}

export type ScanMaterialResult =
  | { processed: true; outcome: "clean" | "quarantined" | "skipped" }
  | { processed: false; reason: string };

interface MaterialScanRow {
  id: string;
  school_id: string;
  storage_key: string;
  original_file_name: string;
  uploaded_by_user_id: string;
  ingest_status: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotFound(error: unknown): boolean {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
}

/**
 * The key the infected object is copied to. The material key scheme is
 * `permanent/<schoolId>/materials/<slug>`, so the quarantine copy is the same key under
 * `quarantine/`. Returns null for a key that is not under `permanent/` — the worker treats that
 * as a data-integrity error and fails closed rather than guessing a destination.
 */
export function quarantineKeyOf(storageKey: string): string | null {
  if (!storageKey.startsWith("permanent/")) return null;
  return `quarantine/${storageKey.slice("permanent/".length)}`;
}

/**
 * Scan the object at `key` and return the verdict, or `"missing"` when it does not exist.
 *
 * The S3 body is handed to clamd as a stream, so the object is never buffered whole in the worker.
 */
async function scanObject(
  s3: ScanS3Client,
  bucket: string,
  key: string,
  config: ClamdConfig,
): Promise<ScanVerdict | "missing"> {
  try {
    const response = await s3.getObject({ Bucket: bucket, Key: key });
    const body = response.Body;
    if (!body) throw new Error("object body is not streamable");
    return await scanStream(body, config);
  } catch (error) {
    if (isNotFound(error)) return "missing";
    throw error;
  }
}

async function objectExists(s3: ScanS3Client, bucket: string, key: string): Promise<boolean> {
  const probe = await s3.headObject({ Bucket: bucket, Key: key });
  return probe.exists;
}

/**
 * Persist an infected verdict: flip the material, notify the uploader, and emit the domain event,
 * all in one transaction guarded by the `scanning` status.
 */
async function applyQuarantine(
  tx: TransactionSql,
  material: MaterialScanRow,
  materialId: string,
  schoolId: string,
  virus: string,
): Promise<void> {
  await tx`
    UPDATE app.materials
    SET ingest_status = 'quarantined'::app.material_ingest_status,
        ingest_error = ${`Infected: ${virus}`},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${materialId}::uuid AND school_id = ${schoolId}::uuid
      AND ingest_status = 'scanning'::app.material_ingest_status
  `;

  // tx.json(), not JSON.stringify() + ::jsonb: ck_notifications_metadata requires a jsonb object,
  // and app.outbox_events has no CHECK to catch the same mistake, so it would store a jsonb string
  // and corrupt every consumer downstream. Same trap attendance-alert.worker.ts documents.
  await tx`
    INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${schoolId}::uuid,
      ${material.uploaded_by_user_id}::uuid,
      ${NOTIFICATION_TYPES.MATERIAL_SCAN_QUARANTINED}::app.notification_type,
      'Upload blocked',
      ${`The file "${material.original_file_name}" was blocked because it is infected with ${virus}.`},
      ${tx.json({ material_id: material.id, virus })}
    )
  `;

  // Shape must match eventPayloadSchemas[MATERIAL_QUARANTINED] in apps/api/src/lib/events/schemas.ts.
  await tx`
    INSERT INTO app.outbox_events (school_id, event_name, payload)
    VALUES (
      ${schoolId}::uuid,
      ${DOMAIN_EVENTS.MATERIAL_QUARANTINED},
      ${tx.json({ materialId, schoolId, virus })}
    )
  `;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Process one confirmed material.
 *
 * `config` is injected rather than read from the environment so the processor is callable from a
 * test against a disposable database and a fake clamd — the shape processFinanceExport and
 * processAttendanceAlert already establish.
 */
export async function processMaterialScan(
  job: Job,
  config: ScanMaterialConfig,
): Promise<ScanMaterialResult> {
  const parsed = scanMaterialJobDataSchema.safeParse(job.data);
  if (!parsed.success) return { processed: false, reason: "invalid job data" };
  const { schoolId, materialId } = parsed.data;

  if (!config.s3 || !config.bucket) throw new Error("scan storage is not configured");
  if (!config.clamd.host) throw new Error("clamd is not configured");

  const sql = postgres(config.databaseUrl, {
    max: 2,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });
  const s3 = config.s3;

  try {
    const material = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
      const [row] = await tx<MaterialScanRow[]>`
        SELECT id, school_id, storage_key, original_file_name, uploaded_by_user_id,
               ingest_status::text AS ingest_status
        FROM app.materials
        WHERE id = ${materialId}::uuid AND school_id = ${schoolId}::uuid
      `;
      return row;
    });

    // Not found, or already past 'scanning' by an earlier (successful) run. Nothing to do — the
    // claim was lost, and that is the dedup working, not a fault. A material already `ready` means
    // a prior attempt committed the clean flip but died before (or while) enqueueing the derivation
    // job, so re-enqueue best-effort here and let the derivation worker's status guard dedup it.
    if (!material || material.ingest_status !== "scanning") {
      if (material && material.ingest_status === "ready") {
        await config.enqueueDerivation({ schoolId, materialId }).catch(() => undefined);
      }
      return { processed: true, outcome: "skipped" };
    }

    const sourceKey = material.storage_key;
    let verdict = await scanObject(s3, config.bucket, sourceKey, config.clamd);
    let recoveredFromQuarantine = false;

    if (verdict === "missing") {
      // A prior attempt copied and deleted the permanent object but died before the flip committed.
      // The quarantine copy holds the same bytes, so re-scanning it yields the same verdict.
      const quarantineKey = quarantineKeyOf(sourceKey);
      if (!quarantineKey) throw new Error("material storage key is not under permanent/");
      if (!(await objectExists(s3, config.bucket, quarantineKey))) {
        throw new Error("material object is missing and has no quarantine copy");
      }
      verdict = await scanObject(s3, config.bucket, quarantineKey, config.clamd);
      if (verdict === "missing") {
        throw new Error("quarantine copy disappeared during retry");
      }
      recoveredFromQuarantine = true;
    }

    if (verdict.kind === "error") {
      // clamd refused or mis-scanned. Never fabricate a clean verdict: throw so BullMQ retries,
      // and the terminal failure path marks the material failed and alerts.
      throw new ClamdScanError(`clamd scan failed: ${verdict.message}`);
    }

    if (verdict.kind === "clean") {
      // The served copy is gone, so 'ready' would be a material with no object to serve. Fail
      // closed: the quarantine copy holding the same bytes re-scanning clean is a clamd
      // inconsistency, and the retry/terminal path must alert rather than invent availability.
      if (recoveredFromQuarantine) {
        throw new Error("material object is missing but its quarantine copy scans clean");
      }
      await withSystemTenantTx(sql, { schoolId }, async (tx) => {
        await tx`
          UPDATE app.materials
          SET ingest_status = 'ready'::app.material_ingest_status,
              ingest_error = NULL,
              ingested_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${materialId}::uuid AND school_id = ${schoolId}::uuid
            AND ingest_status = 'scanning'::app.material_ingest_status
        `;
      });

      // The material is clean, so now the thumbnail/preview can be derived from the same bytes.
      // An enqueue failure propagates: the job retries and self-heals via the already-'ready' path
      // above (status guard) or the derivation worker's keys guard. The derivation job must not be
      // enqueued before the ready flip commits — see the status/keys guards in derivation.worker.ts.
      await config.enqueueDerivation({ schoolId, materialId });

      return { processed: true, outcome: "clean" };
    }

    // Infected. Copy -> delete permanent -> flip, in that order (see the header).
    const quarantineKey = quarantineKeyOf(sourceKey);
    if (!quarantineKey) throw new Error("material storage key is not under permanent/");

    if (!recoveredFromQuarantine) {
      await s3.copyObject({
        Bucket: config.bucket,
        Key: quarantineKey,
        CopySource: `${config.bucket}/${sourceKey}`,
      });

      // Idempotent: if the served copy is already gone (this is a retry that got past the copy),
      // DeleteObject is a no-op.
      await s3.deleteObject({ Bucket: config.bucket, Key: sourceKey });
    }

    await withSystemTenantTx(sql, { schoolId }, (tx) =>
      applyQuarantine(tx, material, materialId, schoolId, verdict.virus),
    );

    return { processed: true, outcome: "quarantined" };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// Terminal-failure hook
// ---------------------------------------------------------------------------

/**
 * Fail closed: when a scan job exhausts its retries the material must never become available.
 *
 * Mirrors the notifications dead-letter listener's shape: synchronously typed because BullMQ does
 * not await listeners, gated on `finishedOn` (assigned only on the no-retry branch — see
 * notifications/dead-letter.ts), and structured-logging first because the log line is the only
 * alert path that survives the database being down.
 */
export function materialScanFailedListener(
  databaseUrl: string,
  log: DeadLetterLogger,
): FailedHandler {
  return (job, error) => {
    if (!isTerminalFailure(job)) return;
    void handleScanFailure({ job, error, databaseUrl, log }).catch((writeError: unknown) => {
      log.error(
        {
          event: "material_scan_failure_write_failed",
          job_id: job.id ?? null,
          err: writeError,
        },
        "could not record a terminally failed material scan",
      );
    });
  };
}

async function handleScanFailure(params: {
  job: FailedJobLike;
  error: Error;
  databaseUrl: string;
  log: DeadLetterLogger;
}): Promise<void> {
  const { job, error, databaseUrl, log } = params;
  const data: Record<string, unknown> =
    typeof job.data === "object" && job.data !== null ? (job.data as Record<string, unknown>) : {};
  const schoolId = typeof data.schoolId === "string" ? data.schoolId : null;
  const materialId = typeof data.materialId === "string" ? data.materialId : null;

  log.error(
    {
      event: "material_scan_failed",
      school_id: schoolId,
      material_id: materialId,
      job_id: job.id ?? null,
      attempts_made: job.attemptsMade,
      err: { type: error.name, message: error.message, stack: error.stack },
    },
    "material scan job exhausted its retries; material marked failed and never served",
  );

  if (schoolId === null || materialId === null) return;

  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 20, prepare: false });
  try {
    await withSystemTenantTx(sql, { schoolId }, async (tx) => {
      const [material] = await tx<{ original_file_name: string; uploaded_by_user_id: string }[]>`
        SELECT original_file_name, uploaded_by_user_id
        FROM app.materials
        WHERE id = ${materialId}::uuid AND school_id = ${schoolId}::uuid
      `;
      if (!material) return;

      await tx`
        UPDATE app.materials
        SET ingest_status = 'failed'::app.material_ingest_status,
            ingest_error = 'Malware scan failed',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${materialId}::uuid AND school_id = ${schoolId}::uuid
          AND ingest_status = 'scanning'::app.material_ingest_status
      `;

      await tx`
        INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
        VALUES (
          ${schoolId}::uuid,
          ${material.uploaded_by_user_id}::uuid,
          ${NOTIFICATION_TYPES.MATERIAL_SCAN_FAILED}::app.notification_type,
          'Upload could not be scanned',
          ${`The file "${material.original_file_name}" could not be scanned and was not made available. Please upload it again.`},
          ${tx.json({ material_id: materialId, reason: "scan_retries_exhausted" })}
        )
      `;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
