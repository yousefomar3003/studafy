/**
 * AI quota gate configuration (ST-155).
 *
 * These are the default ceilings until `app.plans` carries per-plan AI quotas. The gate accepts
 * overrides at construction time, so a plan-driven budget can be layered on without changing the
 * middleware's shape.
 */

/** Default monthly token budget per AI subscription, reset on each billing renewal. */
export const AI_MONTHLY_TOKEN_BUDGET = 1_000_000;

/** How many tokens a request reserves up front while it runs, before it has produced anything. */
export const AI_DEFAULT_RESERVE_TOKENS = 1_000;

/** Redis key prefix for AI quota counters. Keys look like `aiq:{schoolId}:{studentId}:{YYYY-MM-DD}`. */
export const AI_QUOTA_KEY_PREFIX = "aiq";

/**
 * How long past the billing period end a counter key is kept, so a commit that races the period
 * boundary still lands on the window it was reserved against instead of vanishing.
 */
export const AI_QUOTA_PERIOD_GRACE_SECONDS = 300;

/**
 * Default model ids for the LLM gateway (ST-164) small and large tiers. The routing table
 * (`llm/routing.ts`) owns the feature-to-tier mapping; these are the ids a deployment that sets no
 * `AI_LLM_SMALL_MODEL` / `AI_LLM_LARGE_MODEL` override gets. They are the catalog ids current when
 * ST-164 shipped — see docs/runbooks/anthropic-provider-config.md before changing them.
 */
export const AI_LLM_DEFAULT_SMALL_MODEL = "claude-3-5-haiku-20241022";
export const AI_LLM_DEFAULT_LARGE_MODEL = "claude-sonnet-4-20250514";

/**
 * Worst-case reservation the LLM gateway (ST-164) asks the gate to hold for one generation.
 *
 * The generate route's body caps the prompt and system hint at 8,000 characters each — roughly
 * 2,000 tokens each under the codebase's four-chars-per-token estimate — and caps `maxTokens` at
 * 16,384 output tokens. 24,000 covers that ceiling with margin, so the actual-usage commit (input +
 * output tokens reported by the provider) can never exceed the reservation, which the meter treats
 * as a programmer error.
 */
export const AI_LLM_MAX_RESERVE_TOKENS = 24_000;

/**
 * Retry-After value the generate route sends with 503 AI_LLM_UNAVAILABLE. Mirrors the circuit
 * breaker's default cooldown, so a client that honors it retries around the same time the breaker
 * lets a probe through.
 */
export const AI_LLM_RETRY_AFTER_SECONDS = 30;

/**
 * Ask AI streaming endpoint (ST-165).
 *
 * The ask route reserves the same worst-case hold as /generate (AI_LLM_MAX_RESERVE_TOKENS): its
 * output is the same open-ended, large-tier generation, just delivered as a stream instead of one
 * response body.
 */

/** The student's question. Short — this is a chat turn, not the /generate route's raw prompt field. */
export const AI_ASK_QUESTION_MAX_CHARS = 2000;

/**
 * Minimum fused RRF score a grounded answer requires from its best retrieval hit, AND-ed with that
 * hit having matched the keyword leg (see `ask/refusal.ts` for why the AND is load-bearing: the
 * semantic leg here is a deterministic mock, not a real embedding, so its score alone cannot carry
 * a relevance verdict). Below this, the route refuses rather than answers from noise.
 */
export const AI_ASK_MIN_RELEVANCE_SCORE = 0.02;

/** How many retrieval hits are handed to the model as numbered, citable sources. */
export const AI_ASK_SOURCE_LIMIT = 6;

/** Matches the 90-day retention `ai_messages.expires_at` documents (migration 000021). */
export const AI_ASK_MESSAGE_RETENTION_DAYS = 90;

/**
 * Study-material summarizer.
 *
 * The summarize route loads the requested material's ingested text chunks and hands them to the
 * small (fast, cheap) tier as numbered, section-anchored sources. The generation is bounded — a
 * fixed chunk cap and an input-character budget — but the model's output is still open-ended up to
 * the provider's output ceiling, so the route reserves the same worst-case hold as the other
 * generation surfaces (see app.ts, resolveReserveTokens).
 */

/** Maximum number of text chunks fed to the summary model per material, in chunk order. */
export const AI_SUMMARY_CHUNK_LIMIT = 50;

/**
 * Maximum characters of source text handed to the model per material. Applied as a budget to a
 * contiguous prefix of the chunks in order, so the model always sees the material's opening rather
 * than a sparse sample of it. ~4 characters per token ≈ 10,000 input tokens.
 */
export const AI_SUMMARY_MAX_INPUT_CHARS = 40_000;

/** Redis key prefix for summary cache entries. Keys look like `aisum:{studentId}:{materialId}:{fingerprint}`. */
export const AI_SUMMARY_CACHE_KEY_PREFIX = "aisum";

/** How long a cached summary is served before a repeat request regenerates it. */
export const AI_SUMMARY_CACHE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Quiz generator and grader (ST-167).
 *
 * The generate route loads a bounded prefix of each selected material's ingested chunks (mirroring
 * the summarizer's contiguous-prefix-until-budget approach, extended across up to
 * `AI_QUIZ_MAX_MATERIALS` materials), asks the large tier for a strict-JSON question set, and
 * validates every question against the quiz schema (`quiz/schema.ts`) before persisting it -- an
 * output that fails validation is never stored or returned (see `quiz/parser.ts`). The answer key
 * lives only in `app.quiz_questions`; the generation response carries each question's prompt,
 * options (for MCQ), and citation, never the correct answer, so grading is the only way to learn it.
 *
 * There is deliberately no server-side "regenerate on invalid JSON" retry: a schema failure is
 * treated the same as a transport failure (503, not committed to quota), which keeps the route on
 * the same failure posture the rest of the gateway already uses instead of inventing a second one.
 */

/** Upper bound on how many materials one quiz can be generated from in a single request. */
export const AI_QUIZ_MAX_MATERIALS = 5;

/** Maximum number of text chunks fed to the quiz model per material, in chunk order. */
export const AI_QUIZ_CHUNK_LIMIT_PER_MATERIAL = 20;

/**
 * Maximum characters of source text handed to the model across every selected material combined.
 * Applied as a budget to a contiguous prefix of each material's chunks in order (same rule as
 * `AI_SUMMARY_MAX_INPUT_CHARS`). ~4 characters per token ≈ 7,500 input tokens.
 */
export const AI_QUIZ_MAX_INPUT_CHARS = 30_000;

export const AI_QUIZ_MIN_QUESTIONS = 1;

/** Upper bound on `questionCount`; also the worst case the reservation math below is sized against. */
export const AI_QUIZ_MAX_QUESTIONS = 15;

export const AI_QUIZ_DEFAULT_QUESTIONS = 5;

/**
 * Output-token ceiling passed to the provider: `questionCount` scaled by an estimated cost per
 * question (JSON for a prompt, up to a handful of options, a citation, and either a correct option
 * id or a short-answer key -- roughly 220 tokens), plus a fixed buffer, capped so a request can never
 * ask for more than the reservation covers.
 *
 * Worst case at `AI_QUIZ_MAX_QUESTIONS`: 15 * 220 + 300 = 3,600, comfortably under the 4,096 cap.
 * Combined with the ~7,500-token input budget above, one generation call costs at most ~11,100
 * tokens -- well inside `AI_LLM_MAX_RESERVE_TOKENS` (24,000), so the quiz route reuses that existing
 * reservation rather than defining its own.
 */
export const AI_QUIZ_OUTPUT_TOKENS_PER_QUESTION = 220;
export const AI_QUIZ_OUTPUT_TOKEN_BUFFER = 300;
export const AI_QUIZ_OUTPUT_TOKENS_CEILING = 4096;

/** Maximum length of one submitted answer on the grading endpoint. */
export const AI_QUIZ_ANSWER_MAX_CHARS = 1000;

/**
 * Flashcard deck generator and spaced-repetition reviews (ST-168).
 *
 * The generate route loads a bounded prefix of each selected material's ingested chunks -- reusing
 * the quiz loader (`quiz/materials.ts`'s `loadQuizMaterials`) and therefore the quiz input budgets
 * (`AI_QUIZ_MAX_MATERIALS` / `AI_QUIZ_CHUNK_LIMIT_PER_MATERIAL` / `AI_QUIZ_MAX_INPUT_CHARS`) rather
 * than defining a second, identical loader -- asks the small tier for a strict-JSON card list
 * (term/definition and Q/A), and validates every card against the flashcard schema
 * (`flashcards/schema.ts`) before persisting it. Review scheduling and progress are pure SM-2
 * arithmetic (`flashcards/scheduling.ts`), advanced by the review endpoints with no model call and
 * no quota spend.
 */

export const AI_FLASHCARD_MIN_CARDS = 1;

/** Upper bound on `cardCount`; also the worst case the reservation math below is sized against. */
export const AI_FLASHCARD_MAX_CARDS = 20;

export const AI_FLASHCARD_DEFAULT_CARDS = 10;

/**
 * Output-token ceiling passed to the provider: `cardCount` scaled by an estimated cost per card
 * (JSON for a front and a back, a type, and a citation -- roughly 180 tokens), plus a fixed buffer,
 * capped so a request can never ask for more than the reservation covers.
 *
 * Worst case at `AI_FLASHCARD_MAX_CARDS`: 20 * 180 + 300 = 3,900, under the 4,096 cap. Combined
 * with the ~7,500-token input budget the shared quiz loader enforces, one generation call costs at
 * most ~11,400 tokens -- well inside `AI_LLM_MAX_RESERVE_TOKENS` (24,000), so the deck route reuses
 * that existing reservation rather than defining its own.
 */
export const AI_FLASHCARD_OUTPUT_TOKENS_PER_CARD = 180;
export const AI_FLASHCARD_OUTPUT_TOKEN_BUFFER = 300;
export const AI_FLASHCARD_OUTPUT_TOKENS_CEILING = 4096;

/**
 * Maximum number of due cards one review request returns (GET) or accepts (POST). Bounds the
 * payload a study session can ask for in one call.
 */
export const AI_FLASHCARD_REVIEW_LIMIT = 30;
