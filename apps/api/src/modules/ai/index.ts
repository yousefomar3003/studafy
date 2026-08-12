/**
 * AI module (ST-155): entitlement gate, Redis token meter, usage endpoint, hybrid retrieval (ST-162),
 * its cross-encoder re-ranker (ST-163), and the LLM gateway with model routing (ST-164) for
 * `/api/ai/*`.
 *
 * The gate enforces school active -> AI add-on active -> quota available with distinct HTTP codes
 * (403 / 402 / 429); the meter is the atomic Redis ledger that backs the quota decision; the usage
 * route reports the remaining budget; the retrieval route fuses the ANN and keyword legs and, when
 * the re-ranker is wired in, cuts the fused top-20 to a re-scored top-6; the gateway routes a
 * feature to a small/large model tier, calls the Anthropic provider, and commits the provider-
 * reported tokens against the caller's quota.
 */

export {
  AI_DEFAULT_RESERVE_TOKENS,
  AI_LLM_MAX_RESERVE_TOKENS,
  AI_LLM_RETRY_AFTER_SECONDS,
  AI_MONTHLY_TOKEN_BUDGET,
} from "./config";
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
export { aiGatewayRoutes } from "./routes/gateway-routes";
export {
  AI_FEATURES,
  AI_LLM_MODEL_CATALOG,
  AI_MODEL_TIERS,
  AI_ROUTING_TABLE,
  resolveAiModel,
  type AiFeature,
  type AiModelRoute,
  type AiModelTier,
  type AiModelTierConfig,
} from "./llm/routing";
export {
  AI_LLM_API_VERSION,
  AI_LLM_DEFAULT_BASE_URL,
  AI_LLM_DEFAULT_MAX_TOKENS,
  AI_LLM_DEFAULT_TIMEOUT_MS,
  AI_LLM_MAX_ATTEMPTS,
  AnthropicProvider,
  createAnthropicProvider,
  isTransientLlmFailure,
  LlmProviderError,
  type AnthropicProviderOptions,
  type LlmFailureKind,
  type LlmGenerateInput,
  type LlmGeneration,
  type LlmProvider,
  type LlmStreamEvent,
  type LlmUsage,
} from "./llm/provider";
export { recordDurableUsage } from "./usage/durable";
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
