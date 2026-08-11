import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { getAiQuota } from "../gate/entitlement-gate";
import { estimateQueryTokens } from "../retrieval/embeddings";
import {
  RERANK_CANDIDATE_POOL,
  RERANK_K,
  rerankHits,
  type CrossEncoderReranker,
} from "../retrieval/rerank";
import {
  clampLimit,
  hybridSearch,
  HYBRID_MAX_LIMIT,
  type HybridSearchResult,
} from "../retrieval/search";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { QueryEmbedder } from "../retrieval/embeddings";
import type { Context } from "hono";
import type { TransactionSql } from "postgres";

/**
 * Hybrid retrieval endpoint (ST-162): search the school's AI corpus.
 *
 * `POST /api/ai/students/{studentId}/search` runs the RRF hybrid query from
 * `docs/rag/hybrid-search-and-rag-storage.md` against `app.material_chunks` under the caller's
 * tenant transaction, so Row-Level Security filters both legs and a fused result cannot contain
 * another school's chunk. Each hit carries the citation anchors a chat answer renders from — the
 * material title, page number, and section heading — so this endpoint is the retrieval half of a
 * RAG answer, and nothing else.
 *
 * When a re-ranker is wired in (ST-163, gated on the `AI_RERANK_ENABLED` kill switch), the route asks
 * the fusion for a full `RERANK_CANDIDATE_POOL` candidates and cuts the re-scored pool to `RERANK_K`.
 * Both the retrieval surfaces — Ask AI and exam mode — resolve to this endpoint, so one switch flips
 * the re-ranking stage for both.
 *
 * The route rides the ST-155 AI gate: the gate has already reserved a quota hold when the handler
 * runs, and the handler commits the query's embedding cost (the four-chars-per-token rule) and
 * records the same tokens durably in `app.ai_usage_meters`. An unentitled caller is refused by the
 * gate with the same 403/402/429 codes as every other AI surface.
 */

const retrievalHitSchema = z.object({
  /** `app.material_chunks.id`; the chunk a citation points at. */
  chunk_id: z.string().uuid(),
  /** `app.materials.id`; the document the chunk belongs to. */
  material_id: z.string().uuid(),
  /** The material title, joined tenant-composite so it can never come from another school. */
  material_title: z.string().nullable(),
  /** The page anchor a citation renders from ("page 12"). */
  page_number: z.number().int().nullable(),
  /** The section heading the chunk was cut under ("'Photosynthesis'"). */
  section_title: z.string().nullable(),
  /** The chunk text. */
  content: z.string(),
  /** Reciprocal-rank-fusion score: `1/(60+semantic_rank)` + `1/(60+keyword_rank)`. */
  rrf_score: z.number(),
  /** The chunk's rank in the semantic leg, or null when only the keyword leg found it. */
  semantic_rank: z.number().int().nullable(),
  /** The chunk's rank in the keyword leg, or null when only the semantic leg found it. */
  keyword_rank: z.number().int().nullable(),
  /** The cross-encoder's joint score, or null when the re-ranker is not wired in. */
  rerank_score: z.number().nullable(),
});

const retrievalResponseSchema = z.object({
  query: z.string(),
  results: z.array(retrievalHitSchema),
  meta: z.object({
    /** Rows the semantic leg returned on its final attempt — asserted, never assumed. */
    semantic_leg_count: z.number().int(),
    /** True when the semantic leg under-returned and was retried at a higher `ef_search`. */
    retried: z.boolean(),
    /** Tokens committed against this student's AI quota for this search. */
    tokens_used: z.number().int(),
    /** True when the cross-encoder re-ranked the fused candidates before the top-k cut. */
    reranked: z.boolean(),
    /** The re-ranker's model id, or null when the stage was not wired in. */
    rerank_model: z.string().nullable(),
  }),
});

const retrievalSearchBodySchema = z.object({
  query: z.string().trim().min(1).max(500).openapi({
    description: "The search phrase. Runs through websearch_to_tsquery for the keyword leg.",
    example: "How does photosynthesis convert light energy?",
  }),
  limit: z
    .number()
    .int()
    .min(1)
    .max(HYBRID_MAX_LIMIT)
    .optional()
    .openapi({
      description:
        "How many fused results to return. Defaults to 10, max 20. When re-ranking is enabled the " +
        `re-ranker cuts this to at most ${RERANK_K} (the cross-encoder output); a smaller limit still caps it.`,
    }),
});

const retrievalSearchParamsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The student whose AI quota the search draws on.",
    }),
});

const retrievalSearchRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/search",
  tags: ["AI"],
  operationId: "searchAiCorpus",
  summary: "Search the school's AI corpus",
  description:
    "Hybrid retrieval over the school's ingested materials: a pgvector ANN semantic leg fused " +
    "with a full-text keyword leg via Reciprocal Rank Fusion, tenant-isolated by RLS. When the " +
    "cross-encoder re-ranker (ST-163) is enabled, the fused top-20 is re-scored and cut to the top 6. " +
    "Returns the top-ranked chunks with the citation anchors (material, page, section) a chat answer " +
    "renders from. Consumes this student's AI quota.",
  security: [{ bearerAuth: [] }],
  request: {
    params: retrievalSearchParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: retrievalSearchBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Top-ranked retrieval hits with citation anchors.",
        schema: retrievalResponseSchema,
      },
    },
    [400, 401, 402, 403, 422, 429, 500, 503],
  ),
});

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/**
 * Record this search's token cost in the durable per-student ledger. The Redis meter the gate
 * commits to is the quota decision surface; `app.ai_usage_meters` is the durable record the design
 * note reserves for the routes that produce usage. The gate has already proven the student holds an
 * AI subscription, so a missing row is treated as an unchargeable no-op rather than an error.
 */
async function recordDurableUsage(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  tokens: number,
): Promise<void> {
  const [subscription] = await tx<{ id: string }[]>`
    SELECT id
    FROM app.ai_subscriptions
    WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!subscription) return;
  await tx`
    SELECT app.upsert_ai_usage_tokens(${studentId}::uuid, ${subscription.id}::uuid, ${tokens})
  `;
}

export function aiRetrievalRoutes(deps: {
  database: Database;
  embedder: QueryEmbedder;
  /**
   * The cross-encoder re-ranker (ST-163). Null (or absent) when the `AI_RERANK_ENABLED` kill switch
   * is off: the route then returns the fused ranking untouched. `app.ts` owns this decision.
   */
  reranker?: CrossEncoderReranker | null;
}): OpenAPIHono<AppEnv> {
  const { database, embedder, reranker = null } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The audit-coverage gate (tests/audit-coverage.test.ts) requires every mutating route to declare
  // its audit intent. This POST's one write is the metered student's own usage ledger; the
  // declaration is metadata (auditAction never writes a row) — the storage-upload precedent, which
  // declares against a mutation whose record is the object itself rather than an audit_logs row.
  routes.use("/api/ai/students/{studentId}/search", auditAction("update", "ai_usage_meters"));

  routes.openapi(retrievalSearchRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const quota = getAiQuota(c);

    const queryVector = embedder.embed(body.query);
    const tokensUsed = estimateQueryTokens(body.query);

    const result: HybridSearchResult = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const search = await hybridSearch(tx, {
        query: body.query,
        queryVector,
        // The re-ranker needs the full fused top-N to choose from; without it, respect the caller's
        // limit as before.
        limit: reranker ? RERANK_CANDIDATE_POOL : clampLimit(body.limit),
      });
      await recordDurableUsage(tx, auth.schoolId, studentId, tokensUsed);
      return search;
    });

    const requestedLimit = clampLimit(body.limit);
    const meta: {
      semantic_leg_count: number;
      retried: boolean;
      tokens_used: number;
      reranked: boolean;
      rerank_model: string | null;
    } = {
      semantic_leg_count: result.semanticLegCount,
      retried: result.retried,
      tokens_used: tokensUsed,
      reranked: false,
      rerank_model: null,
    };

    let hits = result.hits;
    let rerankScores: ReadonlyMap<string, number> = new Map();
    if (reranker && result.hits.length > 0) {
      const reranked = await rerankHits(body.query, result.hits, reranker);
      hits = reranked.hits;
      rerankScores = reranked.scores;
      meta.reranked = true;
      meta.rerank_model = reranked.model;
    }
    // Rerank cut to RERANK_K; a caller-supplied limit may still tighten the result further.
    hits = hits.slice(0, requestedLimit);

    // The gate released the hold if the handler never settled; committing the real cost settles it.
    await quota.commit(tokensUsed);

    return c.json(
      {
        query: body.query,
        results: hits.map((hit) => ({
          chunk_id: hit.chunkId,
          material_id: hit.materialId,
          material_title: hit.materialTitle,
          page_number: hit.pageNumber,
          section_title: hit.sectionTitle,
          content: hit.content,
          rrf_score: hit.rrfScore,
          semantic_rank: hit.semanticRank,
          keyword_rank: hit.keywordRank,
          rerank_score: rerankScores.get(hit.chunkId) ?? null,
        })),
        meta,
      },
      200,
    );
  });

  return routes;
}
