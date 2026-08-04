import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import postgres from "postgres";

import { withSystemTenantTx } from "../../db/tenant-tx";

import { MaterialParseError } from "./errors";
import { buildIngestChunks } from "./ingest";
import { aiIngestionJobDataSchema } from "./job";

import type { IngestChunk } from "./ingest";
import type { Job } from "bullmq";

export interface AiIngestionWorkerConfig {
  databaseUrl: string;
  databaseCaCert?: string;
  s3Region?: string;
  s3Endpoint?: string;
  bucket?: string;
}

/** The material columns the claim reads, snake_case — postgres.js maps results as-is without a transform option. */
interface MaterialClaim {
  storage_key: string;
  mime_type: string;
  ingest_status: string;
}

type IngestResult =
  | { processed: true; materialId: string; ingested: boolean; chunks: number }
  | { processed: false; reason: string };

/**
 * Process one `ai-ingestion` job: claim the material, extract and chunk its text, and store the
 * chunks on `app.material_chunks`.
 *
 * Lifecycle (driven by `app.material_ingest_status`, migration 000011):
 *  - claim the `app.materials` row FOR UPDATE inside a tenant transaction; a material already
 *    `ready` is an idempotent no-op (the producer may enqueue a job more than once);
 *  - otherwise set `processing`, fetch the bytes from S3, parse + chunk + embed, and in one final
 *    transaction replace the material's chunks and mark it `ready` with `ingested_at`;
 *  - a terminal failure (the last attempt) records `failed` + a reason in `ingest_error`. The
 *    transaction boundary is what makes this safe: a crash mid-insert rolls back and the retry
 *    re-claims from `processing`; a committed insert and a committed `ready` never diverge.
 */
export async function processIngestJob(
  job: Job,
  config: AiIngestionWorkerConfig,
): Promise<IngestResult> {
  const parsed = aiIngestionJobDataSchema.safeParse(job.data);
  if (!parsed.success) return { processed: false, reason: "invalid job data" };
  const data = parsed.data;
  if (!config.bucket || !config.s3Region) throw new Error("ai ingestion storage is not configured");

  const database = postgres(config.databaseUrl, {
    max: 2,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });
  const s3 = new S3Client({
    region: config.s3Region,
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint, forcePathStyle: true } : {}),
  });

  try {
    const material = await withSystemTenantTx(database, { schoolId: data.schoolId }, async (tx) => {
      const [locked] = await tx<MaterialClaim[]>`
        SELECT storage_key, mime_type, ingest_status::text AS ingest_status
        FROM app.materials
        WHERE school_id = ${data.schoolId}::uuid AND id = ${data.materialId}::uuid
        FOR UPDATE
      `;
      if (!locked) throw new Error("material does not exist");
      if (locked.ingest_status !== "ready") {
        await tx`
          UPDATE app.materials
          SET ingest_status = 'processing'::app.material_ingest_status,
              ingest_error = NULL,
              updated_at = clock_timestamp()
          WHERE school_id = ${data.schoolId}::uuid AND id = ${data.materialId}::uuid
        `;
      }
      return locked;
    });

    if (material.ingest_status === "ready") {
      return { processed: true, materialId: data.materialId, ingested: false, chunks: 0 };
    }

    const object = await s3.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: material.storage_key }),
    );
    if (!object.Body) throw new Error("S3 object body is empty");
    const bytes = new Uint8Array(await object.Body.transformToByteArray());
    const chunks = await buildIngestChunks(bytes, material.mime_type);

    await withSystemTenantTx(database, { schoolId: data.schoolId }, async (tx) => {
      await tx`
        DELETE FROM app.material_chunks
        WHERE school_id = ${data.schoolId}::uuid AND material_id = ${data.materialId}::uuid
      `;
      if (chunks.length > 0) {
        await insertChunks(tx, data.schoolId, data.materialId, chunks);
      }
      await tx`
        UPDATE app.materials
        SET ingest_status = 'ready'::app.material_ingest_status,
            ingest_error = NULL,
            ingested_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE school_id = ${data.schoolId}::uuid AND id = ${data.materialId}::uuid
      `;
    });

    return { processed: true, materialId: data.materialId, ingested: true, chunks: chunks.length };
  } catch (error) {
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      await withSystemTenantTx(database, { schoolId: data.schoolId }, async (tx) => {
        await tx`
          UPDATE app.materials
          SET ingest_status = 'failed'::app.material_ingest_status,
              ingest_error = ${failureReason(error)},
              updated_at = clock_timestamp()
          WHERE school_id = ${data.schoolId}::uuid AND id = ${data.materialId}::uuid
            AND ingest_status <> 'ready'
        `;
      });
    }
    throw error;
  } finally {
    await database.end({ timeout: 5 });
  }
}

function insertChunks(
  tx: postgres.TransactionSql,
  schoolId: string,
  materialId: string,
  chunks: readonly IngestChunk[],
): Promise<unknown> {
  return tx`
    INSERT INTO app.material_chunks (
      school_id, material_id, chunk_index, content, page_number, section_title, embedding, embedding_model
    ) ${tx(
      chunks.map((chunk) => ({
        school_id: schoolId,
        material_id: materialId,
        chunk_index: chunk.chunkIndex,
        content: chunk.content,
        page_number: chunk.pageNumber,
        section_title: chunk.sectionTitle,
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

/** The stable reason written to `ingest_error`; parse failures carry their own, everything else a generic one. */
function failureReason(error: unknown): string {
  return error instanceof MaterialParseError ? error.reason : "ingestion failed";
}
