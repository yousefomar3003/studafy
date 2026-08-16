import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  AI_FLASHCARD_DEFAULT_CARDS,
  AI_FLASHCARD_MAX_CARDS,
  AI_FLASHCARD_MIN_CARDS,
  AI_FLASHCARD_OUTPUT_TOKEN_BUFFER,
  AI_FLASHCARD_OUTPUT_TOKENS_CEILING,
  AI_FLASHCARD_OUTPUT_TOKENS_PER_CARD,
  AI_FLASHCARD_REVIEW_LIMIT,
  AI_LLM_RETRY_AFTER_SECONDS,
  AI_QUIZ_MAX_MATERIALS,
} from "../config";
import { parseFlashcardGeneration, FlashcardGenerationInvalidError } from "../flashcards/parser";
import {
  applyCardReviews,
  loadDeckCards,
  loadDueCards,
  loadReviewProgress,
  persistDeck,
} from "../flashcards/persistence";
import { assembleFlashcardPrompt, toFlashcardSources } from "../flashcards/prompt";
import { FLASHCARD_RATINGS, scheduleCard } from "../flashcards/scheduling";
import { FLASHCARD_TYPES } from "../flashcards/schema";
import { getAiQuota } from "../gate/entitlement-gate";
import { throwLlmError } from "../llm/errors";
import { AI_FEATURES, AI_MODEL_TIERS, resolveAiModel } from "../llm/routing";
import { loadQuizMaterials } from "../quiz/materials";
import { recordDurableUsage } from "../usage/durable";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { PersistedCardCitation, PersistedCard } from "../flashcards/persistence";
import type { LlmProvider } from "../llm/provider";
import type { AiModelTier } from "../llm/routing";
import type { Context } from "hono";

/**
 * Flashcard deck generation and spaced-repetition reviews (ST-168):
 * `POST /api/ai/students/{studentId}/decks`, `GET .../decks/{deckId}/review`, and
 * `POST .../decks/{deckId}/review`.
 *
 * Generation grounds term/definition and Q/A cards in the ingested text of one or more materials --
 * reusing the quiz generator's multi-material chunk loader and the same hardened source-block
 * prompting (`ask/prompt.ts`) -- routes the call through the small (fast, cheap) tier, validates the
 * model's JSON response against the flashcard schema (`flashcards/schema.ts` via
 * `flashcards/parser.ts`) before anything is persisted, and returns every card's faces and citation.
 * Unlike quiz generation there is no hidden answer key: a flashcard's back is its study answer and
 * is returned directly, because flashcards are self-graded.
 *
 * Reviews are the spaced-repetition half: a GET returns the deck's due cards (never-reviewed cards
 * are due immediately) with each card's current SM-2 progress, and a POST advances that progress in
 * place with `flashcards/scheduling.ts` -- a pure SM-2 function of the card's current schedule, the
 * student's rating, and the review instant. Reviews draw no LLM tokens and commit zero to quota,
 * exactly like quiz grading; only deck generation is quota-metered.
 *
 * ## Error surface
 *
 * Generation: the shared ST-155 gate 403/402/429; a null provider -> 503 AI_LLM_DISABLED; a material
 * the student's school cannot see or that has no ingested text -> 404 RESOURCE_NOT_FOUND; a material
 * still mid-ingestion -> 422 VALIDATION_FAILED; the shared provider failure taxonomy (503
 * AI_LLM_UNAVAILABLE / AI_LLM_REQUEST_REJECTED); a model response that fails schema validation or
 * cites a source that was never given to it -> 503 AI_FLASHCARD_GENERATION_FAILED with Retry-After,
 * and -- deliberately, see config.ts -- not committed to quota, the same posture a transport failure
 * already gets.
 *
 * Reviews: a deck that does not exist, or belongs to a different student -> 404
 * AI_FLASHCARD_DECK_NOT_FOUND; a review naming a card id outside the deck, or a duplicate review of
 * the same card -> 422 VALIDATION_FAILED.
 */

const FLASHCARD_FEATURE: (typeof AI_FEATURES)[number] = "flashcards";

// ---------------------------------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------------------------------

const flashcardCitationSchema = z.object({
  /** `app.material_chunks.id` this card was grounded on. */
  chunk_id: z.string().uuid(),
  material_id: z.string().uuid(),
  material_title: z.string().nullable(),
  page_number: z.number().int().nullable(),
  section_title: z.string().nullable(),
});

function citationAnchor(citation: PersistedCardCitation) {
  return {
    chunk_id: citation.chunkId,
    material_id: citation.materialId,
    material_title: citation.materialTitle,
    page_number: citation.pageNumber,
    section_title: citation.sectionTitle,
  };
}

// ---------------------------------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------------------------------

const flashcardUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

const flashcardResponseSchema = z.object({
  id: z.string().uuid(),
  /** The card's 1-based position within the deck. */
  order: z.number().int().min(1),
  type: z.enum(FLASHCARD_TYPES),
  front: z.string(),
  back: z.string(),
  citation: flashcardCitationSchema,
});

const generateDeckResponseSchema = z.object({
  deck_id: z.string().uuid(),
  model: z.string(),
  tier: z.enum(AI_MODEL_TIERS),
  feature: z.enum(AI_FEATURES),
  card_count: z.number().int().min(1),
  usage: flashcardUsageSchema,
  cards: z.array(flashcardResponseSchema),
});

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

const generateDeckBodySchema = z.object({
  materialIds: z
    .array(z.string().uuid())
    .min(1)
    .max(AI_QUIZ_MAX_MATERIALS)
    .refine((ids) => !hasDuplicates(ids), { message: "materialIds must not contain duplicates" })
    .openapi({
      description: `The materials to generate the deck from, up to ${AI_QUIZ_MAX_MATERIALS}.`,
      example: ["0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"],
    }),
  cardCount: z
    .number()
    .int()
    .min(AI_FLASHCARD_MIN_CARDS)
    .max(AI_FLASHCARD_MAX_CARDS)
    .optional()
    .openapi({
      description: `How many cards to generate. Defaults to ${AI_FLASHCARD_DEFAULT_CARDS}, up to ${AI_FLASHCARD_MAX_CARDS}.`,
      example: 10,
    }),
});

const deckStudentParamsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The student whose AI quota the deck draws on.",
    }),
});

const generateDeckRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/decks",
  tags: ["AI"],
  operationId: "generateDeck",
  summary: "Generate a term/definition and Q/A flashcard deck from selected materials",
  description:
    "Loads the selected materials' ingested text chunks (reusing the quiz generator's bounded, " +
    "multi-material loader), routes generation through the small (fast) model tier, and validates " +
    "the model's response against the flashcard schema before persisting it -- a response that " +
    "fails schema validation, or cites a source it was never given, is rejected rather than " +
    "stored. Every card carries a citation to the single material chunk it was grounded on. The " +
    "deck is studyable immediately: all cards are due until their first review. Consumes the same " +
    "gate as every other AI surface (403/402/429). Refuses with 404 RESOURCE_NOT_FOUND for a " +
    "material the school cannot see or with no ingested text, 422 VALIDATION_FAILED while a " +
    "material is still mid-ingestion, 503 AI_LLM_DISABLED when the LLM plane is off, 503 " +
    "AI_FLASHCARD_GENERATION_FAILED when the model's output does not validate, and the shared " +
    "provider failure taxonomy (503 AI_LLM_UNAVAILABLE with Retry-After / 503 " +
    "AI_LLM_REQUEST_REJECTED).",
  security: [{ bearerAuth: [] }],
  request: {
    params: deckStudentParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: generateDeckBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The generated deck: every card's faces and citation.",
        schema: generateDeckResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 422, 429, 500, 503],
  ),
});

// ---------------------------------------------------------------------------------------------------
// Review: due cards (GET) and ratings (POST)
// ---------------------------------------------------------------------------------------------------

const deckReviewParamsSchema = deckStudentParamsSchema.extend({
  deckId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "deckId", in: "path" },
      description: "The deck to study, as returned by the generate endpoint.",
    }),
});

const reviewProgressSchema = z.object({
  interval_days: z.number().int().nonnegative(),
  ease_factor: z.number().min(1.3),
  repetitions: z.number().int().nonnegative(),
  due_at: z.string().datetime(),
});

const dueCardResponseSchema = z.object({
  id: z.string().uuid(),
  order: z.number().int().min(1),
  type: z.enum(FLASHCARD_TYPES),
  front: z.string(),
  back: z.string(),
  citation: flashcardCitationSchema,
  /** The student's current schedule for this card, or null if it has never been reviewed. */
  progress: reviewProgressSchema.nullable(),
});

const getDueCardsResponseSchema = z.object({
  deck_id: z.string().uuid(),
  due_count: z.number().int().nonnegative(),
  cards: z.array(dueCardResponseSchema),
});

const getDueCardsRoute = createRoute({
  method: "get",
  path: "/api/ai/students/{studentId}/decks/{deckId}/review",
  tags: ["AI"],
  operationId: "getDueCards",
  summary: "Get a deck's due cards for a study session",
  description:
    "Returns the deck's cards that are due now -- never-reviewed cards are due immediately -- " +
    "each with its front, back, citation, and the student's current SM-2 schedule (or null before " +
    "the first review). Cards whose next review has not arrived yet are omitted. Draws no LLM " +
    "tokens and is not quota-metered. Refuses with 404 AI_FLASHCARD_DECK_NOT_FOUND for a deck that " +
    "does not exist or belongs to a different student.",
  security: [{ bearerAuth: [] }],
  request: {
    params: deckReviewParamsSchema,
  },
  responses: standardResponses(
    {
      200: {
        description: "The deck's due cards and their current schedules.",
        schema: getDueCardsResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 422, 429, 500, 503],
  ),
});

const reviewRatingSchema = z.object({
  card_id: z.string().uuid(),
  rating: z.enum(FLASHCARD_RATINGS),
});

const submitReviewsBodySchema = z.object({
  reviews: z
    .array(reviewRatingSchema)
    .min(1)
    .max(AI_FLASHCARD_REVIEW_LIMIT)
    .refine((reviews) => !hasDuplicates(reviews.map((r) => r.card_id)), {
      message: "reviews must not repeat a card",
    }),
});

const reviewResultSchema = z.object({
  card_id: z.string().uuid(),
  rating: z.enum(FLASHCARD_RATINGS),
  interval_days: z.number().int().nonnegative(),
  ease_factor: z.number().min(1.3),
  repetitions: z.number().int().nonnegative(),
  due_at: z.string().datetime(),
});

const submitReviewsResponseSchema = z.object({
  deck_id: z.string().uuid(),
  reviewed_count: z.number().int().nonnegative(),
  results: z.array(reviewResultSchema),
});

const submitReviewsRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/decks/{deckId}/review",
  tags: ["AI"],
  operationId: "submitReviews",
  summary: "Submit self-graded ratings for a study session",
  description:
    "Advances each card's SM-2 schedule from its current persisted progress and the submitted " +
    "rating (again | hard | good | easy): the schedule is a pure function of the rating and the " +
    "card's previous state, and the new schedule (interval, ease factor, repetitions, next due_at) " +
    "is stored per student-card and returned per review. A card rated `again` becomes due tomorrow; " +
    "a card rated `good`/`easy` moves to the next interval, growing by its ease factor from the " +
    "third pass on. Progress persists per student across sessions. Draws no LLM tokens and is not " +
    "quota-metered. Refuses with 404 AI_FLASHCARD_DECK_NOT_FOUND for a deck that does not exist or " +
    "belongs to a different student, and 422 VALIDATION_FAILED for a review naming a card outside " +
    "the deck or a duplicate review.",
  security: [{ bearerAuth: [] }],
  request: {
    params: deckReviewParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: submitReviewsBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Each reviewed card's new schedule.",
        schema: submitReviewsResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 422, 429, 500, 503],
  ),
});

// ---------------------------------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------------------------------

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function cardAnchor(card: PersistedCard) {
  return {
    id: card.id,
    order: card.order,
    type: card.type,
    front: card.front,
    back: card.back,
    citation: citationAnchor(card.citation),
  };
}

/** `cardCount` scaled by an estimated per-card cost -- see config.ts for the reserve math. */
function deckMaxTokens(cardCount: number): number {
  return Math.min(
    AI_FLASHCARD_OUTPUT_TOKENS_CEILING,
    cardCount * AI_FLASHCARD_OUTPUT_TOKENS_PER_CARD + AI_FLASHCARD_OUTPUT_TOKEN_BUFFER,
  );
}

export function aiFlashcardRoutes(deps: {
  database: Database;
  /**
   * The configured LLM provider, or null when the AI_LLM_ENABLED kill switch is off. Null answers
   * 503 AI_LLM_DISABLED at request time; the route still registers so the published contract does
   * not depend on a deployment's environment (the storage-upload precedent).
   */
  provider: LlmProvider | null;
  /** Environment overrides for the routing table's model ids (`AI_LLM_SMALL_MODEL`). */
  modelOverrides?: Partial<Record<AiModelTier, string>>;
}): OpenAPIHono<AppEnv> {
  const { database, provider, modelOverrides = {} } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The audit-coverage gate (tests/audit-coverage.test.ts) requires every mutating route to declare
  // its audit intent. Generation's writes are app.flashcard_decks, app.flashcards, and the durable
  // usage meter. Review submission's one write is the student's per-card SM-2 progress row.
  routes.use("/api/ai/students/{studentId}/decks", auditAction("insert", "flashcards"));
  routes.use(
    "/api/ai/students/{studentId}/decks/{deckId}/review",
    auditAction("update", "flashcard_reviews"),
  );

  routes.openapi(generateDeckRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    if (!provider) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.AI_LLM_DISABLED,
        getLocalizedMessage(ERROR_CODES.AI_LLM_DISABLED, locale),
      );
    }

    const routed = resolveAiModel("flashcards", modelOverrides);
    const cardCount = body.cardCount ?? AI_FLASHCARD_DEFAULT_CARDS;

    const loaded = await withTenantTx(database, tenantFrom(c), (tx) =>
      loadQuizMaterials(tx, body.materialIds),
    );

    if (loaded.status === "not_found") {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.RESOURCE_NOT_FOUND, locale),
      );
    }
    if (loaded.status === "not_ready") {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(ERROR_CODES.VALIDATION_FAILED, locale),
      );
    }
    if (loaded.chunks.length === 0) {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(ERROR_CODES.VALIDATION_FAILED, locale),
      );
    }

    const sources = toFlashcardSources(loaded.chunks);
    const prompt = assembleFlashcardPrompt(sources, cardCount);

    try {
      const generation = await provider.generate({
        model: routed.model,
        prompt: prompt.user,
        system: prompt.system,
        maxTokens: deckMaxTokens(cardCount),
        userId: auth.userId,
        circuitKey: auth.schoolId,
      });

      // Malformed model output is rejected here, before anything is persisted or any tokens are
      // committed -- see config.ts for why this does not retry server-side.
      const cards = parseFlashcardGeneration(generation.content, sources.length);

      // The provider call deliberately happened outside the transaction above; this short write is
      // all the transaction holds.
      const persisted = await withTenantTx(database, tenantFrom(c), async (tx) => {
        await recordDurableUsage(tx, auth.schoolId, studentId, generation.usage.totalTokens);
        return persistDeck(tx, {
          schoolId: auth.schoolId,
          studentId,
          model: generation.model,
          cards,
          sources,
        });
      });

      await quota.commit(generation.usage.totalTokens);

      return c.json(
        {
          deck_id: persisted.deckId,
          model: generation.model,
          tier: routed.tier,
          feature: FLASHCARD_FEATURE,
          card_count: persisted.cards.length,
          usage: generation.usage,
          cards: persisted.cards.map(cardAnchor),
        },
        200,
      );
    } catch (error) {
      if (error instanceof FlashcardGenerationInvalidError) {
        c.get("log")?.warn(
          { err: error, school_id: auth.schoolId, student_id: studentId },
          "flashcard generation output failed schema validation",
        );
        c.header("Retry-After", String(AI_LLM_RETRY_AFTER_SECONDS));
        throw new CodedHttpException(
          503,
          ERROR_CODES.AI_FLASHCARD_GENERATION_FAILED,
          getLocalizedMessage(ERROR_CODES.AI_FLASHCARD_GENERATION_FAILED, locale),
        );
      }
      throwLlmError(c, error);
    }
  });

  routes.openapi(getDueCardsRoute, async (c) => {
    const { studentId, deckId } = c.req.valid("param");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    const review = await withTenantTx(database, tenantFrom(c), (tx) =>
      loadDueCards(tx, {
        deckId,
        studentId,
        limit: AI_FLASHCARD_REVIEW_LIMIT,
        now: new Date(),
      }),
    );

    if (!review) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.AI_FLASHCARD_DECK_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.AI_FLASHCARD_DECK_NOT_FOUND, locale),
      );
    }

    // No LLM call was made; the reservation is settled at zero, the same posture quiz grading
    // uses.
    await quota.commit(0);

    return c.json(
      {
        deck_id: review.deckId,
        due_count: review.cards.length,
        cards: review.cards.map((card) => ({
          id: card.id,
          order: card.order,
          type: card.type,
          front: card.front,
          back: card.back,
          citation: citationAnchor(card.citation),
          progress:
            card.progress === null
              ? null
              : {
                  interval_days: card.progress.intervalDays,
                  ease_factor: card.progress.easeFactor,
                  repetitions: card.progress.repetitions,
                  due_at: card.progress.dueAt.toISOString(),
                },
        })),
      },
      200,
    );
  });

  routes.openapi(submitReviewsRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId, deckId } = c.req.valid("param");
    const body = c.req.valid("json");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    const deck = await withTenantTx(database, tenantFrom(c), (tx) =>
      loadDeckCards(tx, { deckId, studentId }),
    );

    if (!deck) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.AI_FLASHCARD_DECK_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.AI_FLASHCARD_DECK_NOT_FOUND, locale),
      );
    }

    const cardIds = new Set(deck.cards.map((card) => card.id));
    const foreignCard = body.reviews.find((review) => !cardIds.has(review.card_id));
    if (foreignCard) {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(ERROR_CODES.VALIDATION_FAILED, locale),
      );
    }

    const now = new Date();
    const reviewedCardIds = body.reviews.map((review) => review.card_id);

    // The read-schedule -> schedule -> write-schedule sequence is one transaction, so a concurrent
    // session cannot interleave between the current progress read and the progress write.
    const scheduled = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const progress = await loadReviewProgress(tx, {
        schoolId: auth.schoolId,
        studentId,
        cardIds: reviewedCardIds,
      });

      const next = body.reviews.map((review) => {
        const result = scheduleCard(progress.get(review.card_id) ?? null, review.rating, now);
        return { cardId: review.card_id, rating: review.rating, ...result };
      });

      await applyCardReviews(tx, {
        schoolId: auth.schoolId,
        studentId,
        ratedAt: now,
        reviews: next.map(({ rating: _rating, ...update }) => update),
      });

      return next;
    });

    // No LLM call was made; the reservation is settled at zero, the same posture quiz grading
    // uses.
    await quota.commit(0);

    return c.json(
      {
        deck_id: deck.deckId,
        reviewed_count: scheduled.length,
        results: scheduled.map((result) => ({
          card_id: result.cardId,
          rating: result.rating,
          interval_days: result.intervalDays,
          ease_factor: result.easeFactor,
          repetitions: result.repetitions,
          due_at: result.dueAt.toISOString(),
        })),
      },
      200,
    );
  });

  return routes;
}
