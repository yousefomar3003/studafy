/**
 * Hybrid retrieval over `app.material_chunks` (ST-162): the application-side twin of the RRF query
 * in `docs/rag/hybrid-search-and-rag-storage.md`.
 *
 * Both legs run under forced tenant RLS inside the caller's tenant transaction, so a fused result
 * cannot contain another school's chunk. The two mandatory HNSW settings from the design note are
 * set transaction-locally here (`SET LOCAL`, safe under PgBouncer transaction pooling), and the
 * semantic leg is asserted on its own terms before any fusion: an HNSW index returns the *global*
 * nearest neighbours and RLS filters them afterwards, so a small tenant's ANN query can silently
 * under-return — a shortfall Reciprocal Rank Fusion then hides behind the keyword leg. When the
 * semantic leg returns fewer rows than its limit, the query is retried once at a bounded higher
 * `ef_search` (the production fallback the design note prescribes; never raised without bound, since
 * measured recall *fell* at `ef_search = 400`).
 *
 * The query vector arrives as a pgvector literal or bound parameter — never joined from a table,
 * which would make the ORDER BY non-constant and silently disable the HNSW index.
 */

import type { TransactionSql } from "postgres";

/** The design note's canonical top-k per leg before fusion. */
export const HYBRID_LEG_LIMIT = 50;
/** The mandatory HNSW settings — correctness requirements, not tuning knobs. */
export const HYBRID_ITERATIVE_SCAN = "relaxed_order";
export const HYBRID_EF_SEARCH = 100;
/** The bounded fallback when the semantic leg under-returns. */
export const HYBRID_EF_SEARCH_RETRY = 200;
/** The original RRF paper's fusion constant. */
export const HYBRID_RRF_K = 60;
export const HYBRID_DEFAULT_LIMIT = 10;
export const HYBRID_MAX_LIMIT = 20;

export interface HybridSearchInput {
  /** The raw query text; the FTS leg runs it through `websearch_to_tsquery`. */
  query: string;
  /** The query vector as a pgvector literal, from the route's embedder. */
  queryVector: string;
  /** How many fused results to return (default `HYBRID_DEFAULT_LIMIT`). */
  limit?: number;
}

export interface HybridSearchHit {
  chunkId: string;
  materialId: string;
  materialTitle: string | null;
  pageNumber: number | null;
  sectionTitle: string | null;
  content: string;
  /** Reciprocal-rank-fusion score: the sum of each leg's `1 / (k + rank)`. */
  rrfScore: number;
  /** The chunk's rank in the semantic leg, or null when only the keyword leg found it. */
  semanticRank: number | null;
  /** The chunk's rank in the keyword leg, or null when only the semantic leg found it. */
  keywordRank: number | null;
}

export interface HybridSearchResult {
  hits: HybridSearchHit[];
  /**
   * How many rows the semantic leg returned on its final attempt. Surfaces the RLS+ANN hazard so a
   * caller can see that a short semantic leg was not a fusion artifact.
   */
  semanticLegCount: number;
  /** True when the semantic leg under-returned and was retried at `HYBRID_EF_SEARCH_RETRY`. */
  retried: boolean;
}

interface RawHit {
  chunk_id: string;
  material_id: string;
  material_title: string | null;
  page_number: number | null;
  section_title: string | null;
  content: string;
  rrf_score: number;
  semantic_rank: number | null;
  keyword_rank: number | null;
}

function setHnswSettings(tx: TransactionSql, efSearch: number): Promise<unknown> {
  return Promise.all([
    tx.unsafe(`SET LOCAL hnsw.iterative_scan = '${HYBRID_ITERATIVE_SCAN}'`),
    tx.unsafe(`SET LOCAL hnsw.ef_search = ${efSearch}`),
  ]);
}

/** The semantic leg alone, asserted on its own terms per the design note. */
function semanticLegCount(tx: TransactionSql, queryVector: string): Promise<number> {
  return tx<{ id: string }[]>`
    SELECT id
    FROM app.material_chunks
    ORDER BY embedding <=> ${queryVector}::public.vector
    LIMIT ${HYBRID_LEG_LIMIT}
  `.then((rows) => rows.length);
}

/**
 * Run the fused query. Each leg is RLS-filtered independently, and the fused ids are joined back
 * through `app.material_chunks` (for the citation anchors) and `app.materials` (for the title a
 * citation renders from); both joins are tenant-composite, so a result can never cross schools.
 */
function runHybridQuery(tx: TransactionSql, input: HybridSearchInput): Promise<HybridSearchHit[]> {
  const limit = clampLimit(input.limit);
  return tx<RawHit[]>`
    WITH semantic AS (
      SELECT id, row_number() OVER (ORDER BY embedding <=> ${input.queryVector}::public.vector) AS rank
      FROM app.material_chunks
      ORDER BY embedding <=> ${input.queryVector}::public.vector
      LIMIT ${HYBRID_LEG_LIMIT}
    ), keyword AS (
      SELECT c.id, row_number() OVER (ORDER BY ts_rank(c.content_tsv, q.query) DESC) AS rank
      FROM app.material_chunks c,
           websearch_to_tsquery('english', ${input.query}) AS q(query)
      WHERE c.content_tsv @@ q.query
      ORDER BY ts_rank(c.content_tsv, q.query) DESC
      LIMIT ${HYBRID_LEG_LIMIT}
    ), fused AS (
      SELECT COALESCE(s.id, k.id) AS id,
             s.rank AS semantic_rank,
             k.rank AS keyword_rank,
             COALESCE(1.0 / (${HYBRID_RRF_K} + s.rank), 0) +
               COALESCE(1.0 / (${HYBRID_RRF_K} + k.rank), 0) AS rrf_score
      FROM semantic s FULL OUTER JOIN keyword k ON k.id = s.id
    )
    SELECT c.id AS chunk_id,
           c.material_id,
           m.title AS material_title,
           c.page_number,
           c.section_title,
           c.content,
           f.rrf_score,
           f.semantic_rank,
           f.keyword_rank
    FROM fused f
    JOIN app.material_chunks c ON c.id = f.id
    JOIN app.materials m ON m.id = c.material_id AND m.school_id = c.school_id
    ORDER BY f.rrf_score DESC
    LIMIT ${limit}
  `.then((rows) =>
    rows.map((row) => ({
      chunkId: row.chunk_id,
      materialId: row.material_id,
      materialTitle: row.material_title,
      pageNumber: row.page_number,
      sectionTitle: row.section_title,
      content: row.content,
      rrfScore: Number(row.rrf_score),
      // row_number() OVER emits bigint, which postgres.js returns as a string; normalize so the API
      // contract exposes real numbers.
      semanticRank: row.semantic_rank === null ? null : Number(row.semantic_rank),
      keywordRank: row.keyword_rank === null ? null : Number(row.keyword_rank),
    })),
  );
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return HYBRID_DEFAULT_LIMIT;
  return Math.min(HYBRID_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * One hybrid retrieval pass: assert the semantic leg, retry it once when short, then fuse.
 *
 * `tx` must be an open tenant transaction (see `withTenantTx`), because the RRF query depends on the
 * `app.school_id` GUC for row-level security on both legs.
 */
export async function hybridSearch(
  tx: TransactionSql,
  input: HybridSearchInput,
): Promise<HybridSearchResult> {
  await setHnswSettings(tx, HYBRID_EF_SEARCH);
  let count = await semanticLegCount(tx, input.queryVector);
  let retried = false;
  if (count < HYBRID_LEG_LIMIT) {
    await setHnswSettings(tx, HYBRID_EF_SEARCH_RETRY);
    count = await semanticLegCount(tx, input.queryVector);
    retried = true;
  }
  const hits = await runHybridQuery(tx, input);
  return { hits, semanticLegCount: count, retried };
}
