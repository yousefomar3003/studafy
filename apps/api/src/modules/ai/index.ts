/**
 * AI module (ST-155): entitlement gate, Redis token meter, usage endpoint, hybrid retrieval (ST-162),
 * its cross-encoder re-ranker (ST-163), and the LLM gateway with model routing (ST-164) for
 * `/api/ai/*`, plus the grounded Ask AI stream (ST-165), the cached study-material summarizer, and
 * the quiz generator and grader (ST-167).
 *
 * The gate enforces school active -> AI add-on active -> quota available with distinct HTTP codes
 * (403 / 402 / 429); the meter is the atomic Redis ledger that backs the quota decision; the usage
 * route reports the remaining budget; the retrieval route fuses the ANN and keyword legs and, when
 * the re-ranker is wired in, cuts the fused top-20 to a re-scored top-6; the gateway routes a
 * feature to a small/large model tier, calls the Anthropic provider, and commits the provider-
 * reported tokens against the caller's quota. The quiz generator validates every question against a
 * schema before persisting it, so a malformed or hallucinated-citation response is rejected rather
 * than stored; grading reads the persisted answer key back and scores deterministically, with no
 * model call and no quota spend. The flashcard deck generator (ST-168) validates every card against
 * a schema the same way and returns each card's faces and citation; its review endpoints advance
 * per-student spaced-repetition progress with a pure SM-2 scheduler, with no model call and no
 * quota spend. The simplified-explanations endpoint (ST-170) rewrites one retrieved passage at a
 * selectable age-appropriate level and refuses any output whose sentences are not grounded in the
 * passage's vocabulary.
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
export { aiAskRoutes } from "./routes/ask-routes";
export { aiSummaryRoutes } from "./routes/summary-routes";
export { aiConceptsRoutes } from "./routes/concepts-routes";
export { aiExplainRoutes } from "./routes/explain-routes";
export { aiQuizRoutes } from "./routes/quiz-routes";
export { aiFlashcardRoutes } from "./routes/flashcard-routes";
export {
  createSummaryCache,
  summaryCacheKey,
  summaryFingerprint,
  type SummaryCache,
  type SummaryCacheEntry,
  type SummaryCacheSource,
} from "./summary/cache";
export {
  loadSummaryMaterial,
  type LoadedSummaryChunk,
  type LoadedSummaryMaterial,
  type LoadSummaryMaterialResult,
} from "./summary/materials";
export { assembleSummaryPrompt, type SummaryPrompt } from "./summary/prompt";
export {
  AI_CONCEPTS_MAX_CONCEPTS,
  AI_CONCEPTS_CACHE_KEY_PREFIX,
  AI_CONCEPTS_CACHE_TTL_SECONDS,
} from "./config";
export { AI_EXPLAIN_LEVELS, AI_EXPLAIN_MAX_INPUT_CHARS } from "./config";
export {
  loadExplainPassage,
  type LoadedExplainChunk,
  type LoadExplainPassageResult,
} from "./explain/materials";
export {
  assembleExplainPrompt,
  EXPLAIN_LEVEL_INSTRUCTIONS,
  type ExplainLevel,
  type ExplainPrompt,
} from "./explain/prompt";
export {
  ExplainGenerationInvalidError,
  firstUngroundedSentence,
  isExplanationGrounded,
  wordsOverlap,
} from "./explain/grounding";
export {
  createConceptsCache,
  conceptsCacheKey,
  conceptsFingerprint,
  type ConceptCacheEntry,
  type ConceptCacheItem,
  type ConceptCacheSource,
  type ConceptsCache,
} from "./concepts/cache";
export { assembleConceptsPrompt, type ConceptsPrompt } from "./concepts/prompt";
export { mergeConcepts, type ConceptInput } from "./concepts/merge";
export {
  isConceptGrounded,
  ungroundedConcepts,
  type UngroundedConcept,
} from "./concepts/grounding";
export { ConceptGenerationInvalidError, parseConceptGeneration } from "./concepts/parser";
export {
  conceptGeneratedItemSchema,
  conceptGenerationSchema,
  type ConceptGeneration,
} from "./concepts/schema";
export {
  QUIZ_QUESTION_TYPES,
  quizGenerationSchema,
  quizGeneratedQuestionSchema,
  quizOptionSchema,
  type QuizGeneratedQuestion,
  type QuizGeneration,
  type QuizOption,
  type QuizQuestionType,
} from "./quiz/schema";
export { assembleQuizPrompt, toQuizSources, type QuizPrompt } from "./quiz/prompt";
export {
  loadQuizMaterials,
  type LoadedQuizChunk,
  type LoadQuizMaterialsResult,
} from "./quiz/materials";
export { parseQuizGeneration, QuizGenerationInvalidError } from "./quiz/parser";
export { gradeQuiz, type QuizAnswerInput, type QuizGradeResult } from "./quiz/grading";
export {
  persistQuiz,
  loadQuizForGrading,
  type PersistedQuiz,
  type PersistedQuizQuestion,
} from "./quiz/persistence";
export {
  FLASHCARD_TYPES,
  flashcardGenerationSchema,
  flashcardGeneratedCardSchema,
  type FlashcardGeneration,
  type FlashcardType,
} from "./flashcards/schema";
export {
  FLASHCARD_DEFAULT_EASE_FACTOR,
  FLASHCARD_RATINGS,
  scheduleCard,
  type FlashcardProgress,
  type FlashcardRating,
  type ScheduledReview,
} from "./flashcards/scheduling";
export {
  assembleFlashcardPrompt,
  toFlashcardSources,
  type FlashcardPrompt,
} from "./flashcards/prompt";
export { parseFlashcardGeneration, FlashcardGenerationInvalidError } from "./flashcards/parser";
export {
  persistDeck,
  loadDeckCards,
  loadDueCards,
  loadReviewProgress,
  applyCardReviews,
  type DeckReview,
  type DueCard,
  type PersistedCard,
  type PersistedDeck,
  type ReviewProgress,
  type ReviewUpdate,
} from "./flashcards/persistence";
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
