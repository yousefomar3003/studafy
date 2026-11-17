import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NOTIFICATION_TYPES } from "@studafy/constants";
import { sanitizePlainText } from "@studafy/sanitize";
import { UnrecoverableError } from "bullmq";
import postgres from "postgres";

import { leaseDatabase } from "../../db/pool";
import { withSystemTenantTx } from "../../db/tenant-tx";

import { buildAssignmentBlocks, loadAssignmentSourceContent } from "./assignment-source";
import { createEmbeddingStage, createMockEmbeddingProvider } from "./embedding";
import { MaterialParseError } from "./errors";
import { buildIngestChunks, buildIngestChunksFromBlocks } from "./ingest";
import { aiIngestionJobDataSchema } from "./job";
import { lowConfidencePages, TesseractOcrEngine } from "./ocr";
import { isOcrCandidate } from "./parsers";
import { nullSemaphore, TenantConcurrencyExceededError } from "./semaphore";

import type { IngestChunk } from "./ingest";
import type { OcrReport } from "./ocr";
import type { TenantSemaphore, TenantSemaphoreLease } from "./semaphore";
import type { Job } from "bullmq";
import type { Sql, TransactionSql } from "postgres";

export interface AiIngestionWorkerConfig {
  /** Used only when `sql` is absent: a dedicated pool is opened for this job (tests). */
  databaseUrl: string;
  databaseCaCert?: string;
  /** The process-wide pool (db/pool.ts). Borrowed, never ended here. */
  sql?: Sql;
  s3Region?: string;
  s3Endpoint?: string;
  bucket?: string;
  /** Mean per-word confidence below which an OCR'd page is flagged. Defaults to the engine's 60. */
  ocrLowConfidenceThreshold?: number;
  /** Path to the bundled tesseract worker-script; unset in dev where node_modules holds tesseract's own. */
  ocrWorkerPath?: string;
  /** Directory (path or file:// URL) holding the `<language>.traineddata` files. */
  ocrLangPath?: string;
  /**
   * The per-tenant concurrency gate (ST-161). Omitted in dev/test, where ingestion runs uncapped;
   * the workers registry wires the Redis semaphore with its per-school cap.
   */
  semaphore?: TenantSemaphore;
  /**
   * Fetches the material's bytes, injected by integration tests. Defaults to an S3 GET via
   * `s3Region`/`s3Endpoint`/`bucket` — the same client construction the scan worker's `config.s3`
   * pattern replaces on its side.
   */
  fetchBytes?: (storageKey: string) => Promise<Uint8Array>;
  /**
   * Enqueue the `derive-material-previews` job once ingestion flips the material `ready`. Injected
   * by the workers registry; omitted in tests. Best-effort: called after the ready flip commits, and
   * a lost enqueue degrades to a NULL-key thumbnail icon — the derivation worker's status/key guards
   * make the equivalent scan-worker enqueue (for non-AI materials) a no-op here.
   */
  enqueueDerivation?: (data: { schoolId: string; materialId: string }) => Promise<void>;
}

/** The material columns the claim reads, snake_case — postgres.js maps results as-is without a transform option. */
interface MaterialClaim {
  /** NULL only for an assignment source (000232), which has no file of its own. */
  storage_key: string | null;
  mime_type: string;
  ingest_status: string;
  original_file_name: string;
  uploaded_by_user_id: string;
  ai_visible: boolean;
  /** The class's AI materials setting (000196). */
  class_ai_enabled: boolean;
  /**
   * 'class', or a student's AI source (000232): 'personal' (their own upload, read like any
   * material, but with no thumbnail and no notification -- the student follows it in the AI tools'
   * source list) or 'assignment' (no file of its own: assignment-source.ts reads the assignment
   * and its attachments).
   */
  source_kind: string;
  assignment_id: string | null;
}

/** The columns a re-claim re-reads under FOR UPDATE, to decide whether the work still commits. */
interface MaterialState {
  ingest_status: string;
  ai_visible: boolean;
  class_ai_enabled: boolean;
}

type IngestResult =
  | { processed: true; materialId: string; ingested: boolean; chunks: number }
  | { processed: false; reason: string };

/**
 * Process one `ai-ingestion` job: claim the material, extract and chunk its text, and store the
 * chunks on `app.material_chunks`.
 *
 * Lifecycle (ST-161, driven by `app.material_ingest_status`):
 *  - take a per-tenant concurrency slot, then claim the `app.materials` row FOR UPDATE inside a
 *    tenant transaction. Only materials in `queued` or `processing` with `ai_visible` may be
 *    claimed; anything else (already `ready`, toggled off, unknown state) is an idempotent no-op —
 *    the producer may enqueue a job more than once;
 *  - set `processing`, fetch the bytes (S3 or injected), parse + chunk + embed, and in one final
 *    transaction re-claim FOR UPDATE, replace the material's chunks, notify the uploader, and mark
 *    it `ready` with `ingested_at`. The re-claim is what makes a toggle race safe: if the teacher
 *    disabled AI visibility (or a duplicate job already finished) while this job parsed, the final
 *    transaction skips without writing chunks or notifying;
 *  - a material whose class has its AI materials setting off (000196) is never parsed: the claim
 *    (or, if the setting went off mid-parse, the re-claim) finishes it as `ready` with no chunks and
 *    deletes any it had, so the class's text never reaches the embedding stage and a queued job
 *    cannot strand the material in `queued`. Turning the setting back on re-stages it;
 *  - a terminal failure (the last attempt, or a parse error, which no retry can fix) records
 *    `failed` + a reason in `ingest_error` and notifies the uploader. The transaction boundary is
 *    what makes this safe: a crash mid-insert rolls back and the retry re-claims from
 *    `processing`; a committed insert and a committed `ready` never diverge.
 */
export async function processIngestJob(
  job: Job,
  config: AiIngestionWorkerConfig,
): Promise<IngestResult> {
  const parsed = aiIngestionJobDataSchema.safeParse(job.data);
  if (!parsed.success) return { processed: false, reason: "invalid job data" };
  const data = parsed.data;
  if (!config.fetchBytes && (!config.bucket || !config.s3Region)) {
    throw new Error("ai ingestion storage is not configured");
  }

  const databaseLease = leaseDatabase(config.sql ?? config.databaseUrl, {
    databaseCaCert: config.databaseCaCert,
  });
  const database = databaseLease.sql;
  const semaphore = config.semaphore ?? nullSemaphore;

  let lease: TenantSemaphoreLease | null = null;
  let material: MaterialClaim | undefined;
  try {
    // The cap is checked before the claim so a rejected job never flips the material. The throw
    // makes BullMQ retry with the job's backoff; on the terminal attempt the failure path records
    // it as a scheduling failure (see failureReason).
    lease = await semaphore.acquire(data.schoolId);
    if (!lease) throw new TenantConcurrencyExceededError(data.schoolId);

    let heldBack = false;
    // Thumbnails and notifications are for class materials only (see MaterialClaim.source_kind).
    let classMaterial = true;
    const claim = await withSystemTenantTx(database, { schoolId: data.schoolId }, async (tx) => {
      const [locked] = await tx<MaterialClaim[]>`
        SELECT m.storage_key, m.mime_type, m.ingest_status::text AS ingest_status,
               m.original_file_name, m.uploaded_by_user_id, m.ai_visible, m.source_kind,
               m.assignment_id,
               (m.source_kind = 'personal' OR COALESCE(
                 (SELECT cl.ai_materials_enabled FROM app.classes cl
                  WHERE cl.id = m.class_id AND cl.school_id = m.school_id),
                 false
               )) AS class_ai_enabled
        FROM app.materials m
        WHERE m.school_id = ${data.schoolId}::uuid AND m.id = ${data.materialId}::uuid
        FOR UPDATE OF m
      `;
      if (!locked) throw new Error("material does not exist");
      classMaterial = locked.source_kind === "class";
      if (
        locked.ingest_status === "ready" ||
        !locked.ai_visible ||
        (locked.ingest_status !== "queued" && locked.ingest_status !== "processing")
      ) {
        return null;
      }
      if (!locked.class_ai_enabled) {
        await holdBackMaterial(tx, data.schoolId, data.materialId);
        heldBack = true;
        return null;
      }
      await tx`
        UPDATE app.materials
        SET ingest_status = 'processing'::app.material_ingest_status,
            ingest_error = NULL,
            updated_at = clock_timestamp()
        WHERE school_id = ${data.schoolId}::uuid AND id = ${data.materialId}::uuid
          AND ingest_status IN ('queued', 'processing')
          AND ai_visible = true
      `;
      return locked;
    });

    if (!claim) {
      if (heldBack && classMaterial) {
        await config
          .enqueueDerivation?.({ schoolId: data.schoolId, materialId: data.materialId })
          .catch(() => undefined);
      }
      return { processed: true, materialId: data.materialId, ingested: false, chunks: 0 };
    }
    material = claim;
    // A const snapshot: `material` must stay `MaterialClaim | undefined` for the catch block, but
    // a `let` captured by a closure would widen inside it, so the rest of the success path reads
    // the claim through this non-optional name.
    const claimedMaterial = material;

    const fetchBytes = (storageKey: string) =>
      config.fetchBytes ? config.fetchBytes(storageKey) : fetchFromS3(config, storageKey);
    // Rasters always OCR; PDFs may need it for scanned pages. The engine is a cheap wrapper and
    // spawns its tesseract worker lazily, so a text PDF never pays for the thread.
    let ocr: TesseractOcrEngine | undefined;
    const ocrEngine = () => {
      ocr ??= new TesseractOcrEngine({
        ...(config.ocrLowConfidenceThreshold !== undefined
          ? { lowConfidenceThreshold: config.ocrLowConfidenceThreshold }
          : {}),
        ...(config.ocrWorkerPath !== undefined ? { workerPath: config.ocrWorkerPath } : {}),
        ...(config.ocrLangPath !== undefined ? { langPath: config.ocrLangPath } : {}),
      });
      return ocr;
    };
    let chunks: IngestChunk[];
    let ocrReport: OcrReport | null = null;
    let embeddingTokens = 0;
    try {
      // The stage over the repository's mock provider is the single swap point for a real
      // embedding client: batching, rate limiting, 429 retries and per-tenant metering are all
      // inside the stage, so the worker never changes when the provider does. The mock's vectors
      // only satisfy `embedding NOT NULL`: the API reads none of them while retrieval is
      // lexical-only (ADR-020, QA-15/F-06).
      const embedder = createEmbeddingStage(createMockEmbeddingProvider());
      if (claimedMaterial.source_kind === "assignment") {
        // An assignment source (000232): the assignment's text and its attached files, read in
        // place. A deleted assignment cascades its source away, so a missing one is a race the
        // final re-claim below resolves (the row is gone, nothing is written).
        const content = await withSystemTenantTx(database, { schoolId: data.schoolId }, (tx) =>
          loadAssignmentSourceContent(tx, data.schoolId, claimedMaterial.assignment_id!),
        );
        const blocks = content
          ? await buildAssignmentBlocks(content, { fetchBytes, ocr: ocrEngine })
          : [];
        ({ chunks, embeddingTokens } = await buildIngestChunksFromBlocks(blocks, {
          schoolId: data.schoolId,
          embedder,
        }));
      } else {
        const bytes = await fetchBytes(claimedMaterial.storage_key!);
        ({ chunks, ocrReport, embeddingTokens } = await buildIngestChunks(
          bytes,
          claimedMaterial.mime_type,
          {
            ...(isOcrCandidate(claimedMaterial.mime_type) ? { ocr: ocrEngine() } : {}),
            schoolId: data.schoolId,
            embedder,
          },
        ));
      }
    } finally {
      // The engine lazily spawns a worker thread on first recognize; close it either way so a job
      // never leaks one. `catch` guards close() itself: terminating a broken worker must not mask
      // the parse error that actually matters.
      if (ocr) {
        await ocr.close().catch(() => undefined);
      }
    }
    const lowConfidencePagesList = ocrReport === null ? [] : lowConfidencePages(ocrReport);

    const committed = await withSystemTenantTx(
      database,
      { schoolId: data.schoolId },
      async (tx) => {
        const [state] = await tx<MaterialState[]>`
        SELECT m.ingest_status::text AS ingest_status, m.ai_visible,
               (m.source_kind = 'personal' OR COALESCE(
                 (SELECT cl.ai_materials_enabled FROM app.classes cl
                  WHERE cl.id = m.class_id AND cl.school_id = m.school_id),
                 false
               )) AS class_ai_enabled
        FROM app.materials m
        WHERE m.school_id = ${data.schoolId}::uuid AND m.id = ${data.materialId}::uuid
        FOR UPDATE OF m
      `;
        // The teacher may have toggled AI visibility off (or a duplicate job already finished) while
        // this job parsed. Skip — never write chunks for a hidden material or notify for a stale one.
        if (!state || state.ingest_status !== "processing" || !state.ai_visible) {
          return false;
        }
        // The class's AI materials setting went off while this job parsed: drop the parsed text
        // and finish the material chunk-free, exactly as the claim would have.
        if (!state.class_ai_enabled) {
          await holdBackMaterial(tx, data.schoolId, data.materialId);
          heldBack = true;
          return false;
        }
        await tx`
        DELETE FROM app.material_chunks
        WHERE school_id = ${data.schoolId}::uuid AND material_id = ${data.materialId}::uuid
      `;
        if (chunks.length > 0) {
          await insertChunks(tx, data.schoolId, data.materialId, chunks);
        }
        if (lowConfidencePagesList.length > 0 && classMaterial) {
          await notifyLowConfidencePages(
            tx,
            claimedMaterial,
            data.materialId,
            data.schoolId,
            lowConfidencePagesList,
          );
        }
        if (classMaterial) {
          await notifyIngested(tx, claimedMaterial, data.materialId, data.schoolId);
        }
        await tx`
        UPDATE app.materials
        SET ingest_status = 'ready'::app.material_ingest_status,
            ingest_error = NULL,
            ingested_at = clock_timestamp(),
            embedding_token_cost = ${embeddingTokens},
            updated_at = clock_timestamp()
        WHERE school_id = ${data.schoolId}::uuid AND id = ${data.materialId}::uuid
      `;
        return true;
      },
    );

    // The material is `ready` now, so the thumbnail/preview can be derived from the same bytes.
    // Best-effort by design: an enqueue failure must not fail an already-committed ingestion, and a
    // missing thumbnail degrades to the list's type icon rather than a failed material.
    if ((committed || heldBack) && classMaterial) {
      await config
        .enqueueDerivation?.({ schoolId: data.schoolId, materialId: data.materialId })
        .catch(() => undefined);
    }

    return {
      processed: true,
      materialId: data.materialId,
      ingested: committed,
      chunks: committed ? chunks.length : 0,
    };
  } catch (error) {
    // A parse error is a verdict on the file's bytes (corrupt, encrypted, unsupported, no text):
    // every retry would read the same bytes and fail the same way, only later -- with the default
    // 5 attempts that is 75 s of backoff plus four more parses before the teacher sees "failed".
    // So it is recorded as the terminal failure now and the job is not retried. Anything else (the
    // bucket, the database, the concurrency cap) may be transient and keeps its retries.
    const deterministic = error instanceof MaterialParseError;
    if (deterministic || job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      const reason = failureReason(error);
      await withSystemTenantTx(database, { schoolId: data.schoolId }, async (tx) => {
        const [state] = await tx<MaterialState[]>`
          SELECT ingest_status::text AS ingest_status, ai_visible
          FROM app.materials
          WHERE school_id = ${data.schoolId}::uuid AND id = ${data.materialId}::uuid
          FOR UPDATE
        `;
        // A duplicate job may have succeeded and flipped the material ready while this one died;
        // never downgrade a committed ingestion to failed.
        if (!state || state.ingest_status === "ready") return;
        await tx`
          UPDATE app.materials
          SET ingest_status = 'failed'::app.material_ingest_status,
              ingest_error = ${reason},
              updated_at = clock_timestamp()
          WHERE school_id = ${data.schoolId}::uuid AND id = ${data.materialId}::uuid
        `;
        if (material && material.source_kind === "class") {
          await notifyIngestFailed(tx, material, data.materialId, data.schoolId, reason);
        }
      });
    }
    if (deterministic) throw new UnrecoverableError(error.message);
    throw error;
  } finally {
    await lease?.release().catch(() => undefined);
    await databaseLease.release();
  }
}

/**
 * Finish a material of a class whose AI materials setting is off (000196) without ingesting it:
 * no chunks (any left from an earlier run are deleted) and `ready` with an ingest stamp, the state
 * the scan worker gives a clean material that is not AI-bound. Must run under the material's row
 * lock, which both callers hold.
 */
async function holdBackMaterial(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
): Promise<void> {
  await tx`
    DELETE FROM app.material_chunks
    WHERE school_id = ${schoolId}::uuid AND material_id = ${materialId}::uuid
  `;
  await tx`
    UPDATE app.materials
    SET ingest_status = 'ready'::app.material_ingest_status,
        ingest_error = NULL,
        ingested_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE school_id = ${schoolId}::uuid AND id = ${materialId}::uuid
  `;
}

async function fetchFromS3(
  config: AiIngestionWorkerConfig,
  storageKey: string,
): Promise<Uint8Array> {
  const s3 = new S3Client({
    region: config.s3Region,
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint, forcePathStyle: true } : {}),
  });
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: storageKey }));
    if (!object.Body) throw new Error("S3 object body is empty");
    return new Uint8Array(await object.Body.transformToByteArray());
  } finally {
    s3.destroy();
  }
}

/**
 * `content` and `section_title` are extracted straight from an uploaded PDF/DOCX/PPTX (ST-296): the
 * `apps/workers/src/queues/ai-ingestion/parsers` walk document text nodes, not markup, so nothing
 * upstream of this insert ever interprets the bytes as HTML — but that also means an uploaded file
 * can carry a literal `<script>...</script>` straight into storage unless something neutralizes it
 * here, the same way a request body is sanitized at the API's write boundary
 * (docs/security/content_sanitization_policy.md). Sanitizing at the insert — after chunking and
 * embedding, not before — keeps `buildIngestChunks` a pure, fixture-testable pipeline over the
 * document's real extracted text.
 */
function insertChunks(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
  chunks: readonly IngestChunk[],
): Promise<unknown> {
  // The column list comes from the helper, not the SQL text: postgres.js picks its builder from the
  // last keyword before the interpolation, and a literal "(...)" column list there selects the
  // select builder, which cannot serialize an array of rows.
  return tx`
    INSERT INTO app.material_chunks ${tx(
      chunks.map((chunk) => ({
        school_id: schoolId,
        material_id: materialId,
        chunk_index: chunk.chunkIndex,
        content: sanitizePlainText(chunk.content),
        page_number: chunk.pageNumber,
        section_title: chunk.sectionTitle === null ? null : sanitizePlainText(chunk.sectionTitle),
        embedding: chunk.embedding,
        embedding_model: chunk.embeddingModel,
      })),
      "school_id",
      "material_id",
      "chunk_index",
      "content",
      "page_number",
      "section_title",
      "embedding",
      "embedding_model",
    )}
  `;
}

/**
 * Tell the uploader that OCR was confident enough to transcribe the material but not enough to trust
 * it wholesale — the page numbers whose mean per-word confidence fell below the flagging threshold.
 * Written inside the same transaction that flips the material `ready`, so a notification can never
 * be observed for a material that did not actually ingest, and the at-least-once job semantics stay
 * safe: a retried job re-claims from `processing`, and the re-claim guard above makes the whole
 * second run a no-op (no duplicate chunks, no duplicate notification).
 */
function notifyLowConfidencePages(
  tx: TransactionSql,
  material: MaterialClaim,
  materialId: string,
  schoolId: string,
  pages: readonly number[],
): Promise<unknown> {
  const pageList = pages.join(", ");
  return tx`
    INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${schoolId}::uuid,
      ${material.uploaded_by_user_id}::uuid,
      ${NOTIFICATION_TYPES.MATERIAL_OCR_LOW_CONFIDENCE}::app.notification_type,
      'Material may need a review',
      ${`The file "${material.original_file_name}" was transcribed automatically, but page ${pageList} ${pages.length === 1 ? "was" : "were"} hard to read. Please check ${pages.length === 1 ? "it" : "them"}.`},
      ${tx.json({ material_id: materialId, pages: [...pages] })}
    )
  `;
}

/**
 * Tell the uploader the material is ready for AI search. Written inside the same transaction that
 * flips the material `ready` — a notification can never be observed for a material that did not
 * actually ingest, and the re-claim guard keeps a duplicate job from notifying twice.
 */
function notifyIngested(
  tx: TransactionSql,
  material: MaterialClaim,
  materialId: string,
  schoolId: string,
): Promise<unknown> {
  return tx`
    INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${schoolId}::uuid,
      ${material.uploaded_by_user_id}::uuid,
      ${NOTIFICATION_TYPES.MATERIAL_INGESTED}::app.notification_type,
      'Material is ready',
      ${`The file "${material.original_file_name}" has finished processing and is now searchable.`},
      ${tx.json({ material_id: materialId })}
    )
  `;
}

/**
 * Tell the uploader ingestion could not complete. Written inside the same transaction that flips
 * the material `failed`, so the two can never diverge.
 */
function notifyIngestFailed(
  tx: TransactionSql,
  material: MaterialClaim,
  materialId: string,
  schoolId: string,
  reason: string,
): Promise<unknown> {
  return tx`
    INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${schoolId}::uuid,
      ${material.uploaded_by_user_id}::uuid,
      ${NOTIFICATION_TYPES.MATERIAL_INGEST_FAILED}::app.notification_type,
      'Material could not be processed',
      ${`The file "${material.original_file_name}" could not be processed and is not searchable. You can try again from the material page.`},
      ${tx.json({ material_id: materialId, reason })}
    )
  `;
}

/** The stable reason written to `ingest_error`; parse failures carry their own, everything else a generic one. */
function failureReason(error: unknown): string {
  if (error instanceof TenantConcurrencyExceededError) return "concurrency limit reached";
  return error instanceof MaterialParseError ? error.reason : "ingestion failed";
}
