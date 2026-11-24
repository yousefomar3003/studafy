/**
 * Chunk re-embed sweep (ADR-021).
 *
 * Gives every `app.material_chunks` row a vector from the live embedding model. Rows carrying any
 * other `embedding_model` -- the mock every chunk was written with before ADR-021, a chunk the
 * ingestion worker had to store with the mock while the provider was down, or an older model after
 * a model change -- are re-embedded from their stored `content` and relabeled, which is the
 * regeneration procedure in docs/rag/hybrid-search-and-rag-storage.md run continuously instead of
 * once. Until a row is reached, the semantic leg ignores it (it reads only the live model's rows)
 * and the keyword leg still finds it, so the sweep only ever improves search.
 *
 * Per school, in batches: the rows are read in one short transaction, embedded with no transaction
 * open (the provider call can take seconds), and written back in another, guarded on the label they
 * were read with so a row re-ingested in between is left alone. A run handles at most
 * {@link CHUNK_REEMBED_MAX_PER_RUN} rows so a large backlog is spread over several runs, and a
 * school whose batch fails is skipped until the next run.
 */

import { withSystemTenantTx } from "../../db/tenant-tx";
import { createEmbeddingStage } from "../ai-ingestion/embedding";
import { loadSchoolIds } from "../notifications/email/schools";

import type { EmbeddingProvider } from "../ai-ingestion/embedding";
import type { PurgeLogger } from "../imports";
import type { Sql } from "postgres";

/** Rows read, embedded and written back together. */
export const CHUNK_REEMBED_BATCH_SIZE = 32;
/** The most rows one run re-embeds across every school. */
export const CHUNK_REEMBED_MAX_PER_RUN = 2000;

export interface ReembedStaleChunksResult {
  schools: number;
  /** Rows given a vector from the live model. */
  reembedded: number;
  /** Schools whose batch failed (provider or database error); retried next run. */
  failed: number;
}

export interface ReembedStaleChunksOptions {
  batchSize?: number;
  maxPerRun?: number;
}

const silentLogger: PurgeLogger = { warn: () => undefined };

export async function reembedStaleChunks(
  sql: Sql,
  provider: EmbeddingProvider,
  log: PurgeLogger = silentLogger,
  options: ReembedStaleChunksOptions = {},
): Promise<ReembedStaleChunksResult> {
  const batchSize = options.batchSize ?? CHUNK_REEMBED_BATCH_SIZE;
  let budget = options.maxPerRun ?? CHUNK_REEMBED_MAX_PER_RUN;
  const stage = createEmbeddingStage(provider, { requestsPerSecond: 5 });
  const schoolIds = await loadSchoolIds(sql);
  const result: ReembedStaleChunksResult = { schools: schoolIds.length, reembedded: 0, failed: 0 };

  for (const schoolId of schoolIds) {
    if (budget <= 0) break;
    try {
      for (;;) {
        const limit = Math.min(batchSize, budget);
        if (limit <= 0) break;
        const rows = await withSystemTenantTx(
          sql,
          { schoolId },
          (tx) =>
            tx<{ id: string; content: string; embedding_model: string }[]>`
            SELECT id, content, embedding_model
            FROM app.material_chunks
            WHERE embedding_model <> ${provider.model}
            ORDER BY id
            LIMIT ${limit}
          `,
        );
        if (rows.length === 0) break;
        // The budget falls by what was read, written back or not, so a run always ends.
        budget -= rows.length;

        const embedded = await stage.embed(
          rows.map((row, index) => ({
            chunkIndex: index,
            content: row.content,
            pageNumber: null,
            sectionTitle: null,
          })),
        );
        const updated = await withSystemTenantTx(sql, { schoolId }, (tx) =>
          tx`
            UPDATE app.material_chunks AS c
            SET embedding = v.embedding::public.vector,
                embedding_model = ${provider.model},
                updated_at = CURRENT_TIMESTAMP
            FROM (
              SELECT unnest(${rows.map((row) => row.id)}::uuid[]) AS id,
                     unnest(${embedded.chunks.map((chunk) => chunk.embedding)}::text[]) AS embedding,
                     unnest(${rows.map((row) => row.embedding_model)}::text[]) AS read_model
            ) AS v
            WHERE c.id = v.id AND c.embedding_model = v.read_model
          `.then((written) => written.count),
        );
        result.reembedded += updated;
        if (rows.length < limit) break;
      }
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "chunk re-embed failed for school; its rows keep their old vectors until the next run",
      );
    }
  }

  return result;
}
