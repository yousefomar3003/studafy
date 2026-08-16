/**
 * Exam mode (ST-171) — numeric bounds shared between apps/api (request validation, quota
 * reservation math) and apps/workers (the generation job that actually loads materials and prompts
 * the model). Plain numbers with no logic attached, the same reason QUEUE_NAMES/JOB_NAMES live here
 * rather than duplicated per app: producer and consumer must agree on the same values, and a drift
 * here would silently accept a request the worker then rejects (or the reverse).
 *
 * Everything with actual behavior (the LLM client, the grounding schema/parser, the prompt
 * assembly) stays local to apps/workers rather than living here or in a new shared package — see
 * docs/rag/exam-mode.md for why.
 */

/** Upper bound on how many materials one exam can be generated from in a single request. */
export const AI_EXAM_MAX_MATERIALS = 8;

/** Maximum number of text chunks fed to the exam model per material, in chunk order. */
export const AI_EXAM_CHUNK_LIMIT_PER_MATERIAL = 20;

/**
 * Maximum characters of source text handed to the model across every selected material combined.
 * Applied as a budget to a contiguous prefix of each material's chunks in order — the same rule
 * `AI_QUIZ_MAX_INPUT_CHARS` applies, sized larger here because an exam's scope is meant to span more
 * of a topic than one quiz. ~4 characters per token ≈ 15,000 input tokens.
 */
export const AI_EXAM_MAX_INPUT_CHARS = 60_000;

export const AI_EXAM_MIN_QUESTIONS = 5;

/** Upper bound on `questionCount`; also the worst case the reservation math is sized against. */
export const AI_EXAM_MAX_QUESTIONS = 40;

export const AI_EXAM_DEFAULT_QUESTIONS = 20;

/** Bounds on the requested exam duration. */
export const AI_EXAM_MIN_DURATION_MINUTES = 5;
export const AI_EXAM_MAX_DURATION_MINUTES = 180;
export const AI_EXAM_DEFAULT_DURATION_MINUTES = 30;

/**
 * A topic (material) is flagged `weak` in the per-topic report when its correct-answer percentage
 * falls at or below this threshold. 60, not 50: a report meant to surface what to re-study should
 * flag "shaky", not only "failing".
 */
export const AI_EXAM_WEAK_TOPIC_THRESHOLD = 60;
