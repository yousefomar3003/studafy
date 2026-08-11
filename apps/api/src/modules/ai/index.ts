/**
 * AI module (ST-155): entitlement gate, Redis token meter, usage endpoint, hybrid retrieval (ST-162),
 * and its cross-encoder re-ranker (ST-163) for `/api/ai/*`.
 *
 * The gate enforces school active -> AI add-on active -> quota available with distinct HTTP codes
 * (403 / 402 / 429); the meter is the atomic Redis ledger that backs the quota decision; the usage
 * route reports the remaining budget; the retrieval route fuses the ANN and keyword legs and, when
 * the re-ranker is wired in, cuts the fused top-20 to a re-scored top-6.
 */

export { AI_DEFAULT_RESERVE_TOKENS, AI_MONTHLY_TOKEN_BUDGET } from "./config";
export {
  aiEntitlementGate,
  assertAiEntitled,
  getAiQuota,
  type AiEntitlementContext,
  type AiQuotaGateOptions,
  type AiQuotaHandle,
} from "./gate/entitlement-gate";
export { aiUsageRoutes } from "./routes/usage-routes";
export { aiRetrievalRoutes } from "./routes/retrieval-routes";
export {
  createDeterministicQueryEmbedder,
  deterministicQueryEmbedding,
  estimateQueryTokens,
  RETRIEVAL_EMBEDDING_DIMENSIONS,
  RETRIEVAL_EMBEDDING_MODEL,
  type QueryEmbedder,
} from "./retrieval/embeddings";
export {
  clampLimit,
  hybridSearch,
  HYBRID_DEFAULT_LIMIT,
  HYBRID_EF_SEARCH,
  HYBRID_EF_SEARCH_RETRY,
  HYBRID_ITERATIVE_SCAN,
  HYBRID_LEG_LIMIT,
  HYBRID_MAX_LIMIT,
  HYBRID_RRF_K,
  type HybridSearchHit,
  type HybridSearchInput,
  type HybridSearchResult,
} from "./retrieval/search";
export {
  createDeterministicCrossEncoderReranker,
  queryCoverage,
  RERANK_CANDIDATE_POOL,
  RERANK_K,
  RERANK_MODEL,
  rerankHits,
  type CrossEncoderReranker,
  type Rerankable,
  type RerankCandidate,
  type RerankHitsOptions,
  type RerankHitsResult,
  type RerankScore,
} from "./retrieval/rerank";
export {
  createAiTokenMeter,
  aiQuotaKey,
  aiQuotaPeriodKey,
  type AiCommitInput,
  type AiQuotaRefusal,
  type AiReleaseInput,
  type AiReservation,
  type AiReservationResult,
  type AiReserveInput,
  type AiSettleResult,
  type AiSnapshotInput,
  type AiTokenMeter,
  type AiUsageSnapshot,
} from "./usage/meter";
