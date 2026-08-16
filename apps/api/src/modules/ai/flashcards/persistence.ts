import type { FlashcardGeneration, FlashcardType } from "./schema";
import type { GroundedSource } from "../ask/prompt";
import type { TransactionSql } from "postgres";

/**
 * Flashcard persistence (ST-168).
 *
 * One row in `app.flashcard_decks` per generation, one row in `app.flashcards` per card, each card
 * carrying its citation (`material_chunk_id`, a composite FK to `app.material_chunks`) -- the same
 * normalized, answer-visible shape `quiz/persistence.ts` uses, minus the hidden answer key: a
 * flashcard's back is its answer and is returned to the student, because flashcards are
 * self-graded. Cards carry no SM-2 state here; that lives in `app.flashcard_reviews`, one row per
 * student-card, updated in place on every review (`applyCardReviews`). Everything runs in the
 * caller's tenant transaction, so a half-written deck can never land.
 *
 * `loadDueCards` is the progress-tracking read: a deck's cards in order, left-joined to the
 * student's review schedule, keeping only cards that are due now -- or never reviewed, which are
 * due immediately. The schedule columns (`interval_days`, `ease_factor`, `repetitions`, `due_at`)
 * come back null for those; the route renders them as an explicit `"progress": null`.
 */

export interface PersistDeckInput {
  schoolId: string;
  studentId: string;
  model: string;
  /** Validated model output, in the order it will be numbered 1..N within the deck. */
  cards: FlashcardGeneration;
  /** The numbered sources the prompt was built from; `card.source_id` indexes into this (1-based). */
  sources: readonly GroundedSource[];
}

export interface PersistedCardCitation {
  chunkId: string;
  materialId: string;
  materialTitle: string | null;
  pageNumber: number | null;
  sectionTitle: string | null;
}

export interface PersistedCard {
  id: string;
  /** The card's 1-based position within its deck. */
  order: number;
  type: FlashcardType;
  front: string;
  back: string;
  citation: PersistedCardCitation;
}

export interface PersistedDeck {
  deckId: string;
  cards: PersistedCard[];
}

export async function persistDeck(
  tx: TransactionSql,
  input: PersistDeckInput,
): Promise<PersistedDeck> {
  const [deck] = await tx<{ id: string }[]>`
    INSERT INTO app.flashcard_decks (school_id, student_id, model, card_count)
    VALUES (
      ${input.schoolId}::uuid, ${input.studentId}::uuid, ${input.model}, ${input.cards.length}
    )
    RETURNING id
  `;
  const deckId = deck!.id;

  const cards: PersistedCard[] = [];

  // Sequential insert, one card at a time -- the same bounded-loop shape quiz/persistence.ts uses
  // for questions and ask/persistence.ts for citations, kept identical rather than reaching for
  // postgres.js's multi-row helper.
  for (const [index, card] of input.cards.entries()) {
    const order = index + 1;
    // Bounds-checked by flashcards/parser.ts before this function is ever called: source_id is
    // always in [1, sources.length].
    const source = input.sources[card.source_id - 1]!;

    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.flashcards (
        school_id, deck_id, card_order, card_type, front, back, material_chunk_id
      ) VALUES (
        ${input.schoolId}::uuid,
        ${deckId}::uuid,
        ${order},
        ${card.type},
        ${card.front},
        ${card.back},
        ${source.chunkId}::uuid
      )
      RETURNING id
    `;

    cards.push({
      id: row!.id,
      order,
      type: card.type,
      front: card.front,
      back: card.back,
      citation: {
        chunkId: source.chunkId,
        materialId: source.materialId,
        materialTitle: source.materialTitle,
        pageNumber: source.pageNumber,
        sectionTitle: source.sectionTitle,
      },
    });
  }

  return { deckId, cards };
}

// ---------------------------------------------------------------------------------------------------
// Review read paths
// ---------------------------------------------------------------------------------------------------

export interface DeckCardRef {
  id: string;
  order: number;
}

export interface LoadedDeckCards {
  deckId: string;
  cards: DeckCardRef[];
}

/**
 * Load a deck's card ids and ordinals, scoped to the student who owns it.
 *
 * `student_id` is filtered explicitly, the same posture `quiz/persistence.ts`'s
 * `loadQuizForGrading` takes: RLS already fences the school, but nothing fences the student, so a
 * deck generated for a different student in the same school must still read as absent here. Returns
 * null when no such deck exists for this student in this school -- the review routes map that to
 * 404 `AI_FLASHCARD_DECK_NOT_FOUND`.
 */
export async function loadDeckCards(
  tx: TransactionSql,
  input: { deckId: string; studentId: string },
): Promise<LoadedDeckCards | null> {
  const [deck] = await tx<{ id: string }[]>`
    SELECT id FROM app.flashcard_decks
    WHERE id = ${input.deckId}::uuid AND student_id = ${input.studentId}::uuid
  `;
  if (!deck) return null;

  const rows = await tx<{ id: string; card_order: number }[]>`
    SELECT id, card_order
    FROM app.flashcards
    WHERE deck_id = ${deck.id}::uuid
    ORDER BY card_order ASC
  `;

  return {
    deckId: deck.id,
    cards: rows.map((row) => ({ id: row.id, order: row.card_order })),
  };
}

export interface ReviewProgress {
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
  dueAt: Date;
}

/**
 * Load the current SM-2 progress for a set of cards, scoped to one student.
 *
 * Used by the review route to schedule the *next* review from the *latest* schedule: the map it
 * returns feeds `flashcards/scheduling.ts`, whose output `applyCardReviews` then stores. Returns an
 * empty map when the student has never reviewed any of the cards -- each of those is a fresh card to
 * the scheduler. `ease_factor` is cast to float8 in the query because postgres.js returns
 * `numeric` columns as strings.
 */
export async function loadReviewProgress(
  tx: TransactionSql,
  input: { schoolId: string; studentId: string; cardIds: readonly string[] },
): Promise<Map<string, ReviewProgress>> {
  const progress = new Map<string, ReviewProgress>();
  if (input.cardIds.length === 0) return progress;

  const rows = await tx<
    {
      card_id: string;
      interval_days: number;
      ease_factor: number;
      repetitions: number;
      due_at: Date;
    }[]
  >`
    SELECT card_id, interval_days, ease_factor::float8 AS ease_factor, repetitions, due_at
    FROM app.flashcard_reviews
    WHERE school_id = ${input.schoolId}::uuid
      AND student_id = ${input.studentId}::uuid
      AND card_id IN ${tx([...input.cardIds])}
  `;

  for (const row of rows) {
    progress.set(row.card_id, {
      intervalDays: row.interval_days,
      easeFactor: row.ease_factor,
      repetitions: row.repetitions,
      dueAt: row.due_at,
    });
  }

  return progress;
}

export interface DueCard {
  id: string;
  order: number;
  type: FlashcardType;
  front: string;
  back: string;
  citation: PersistedCardCitation;
  /** The student's current schedule for this card, or null if it has never been reviewed. */
  progress: ReviewProgress | null;
}

export interface DeckReview {
  deckId: string;
  cards: DueCard[];
}

/**
 * Load a deck's due cards for the owning student: never-reviewed cards (due immediately) plus
 * reviewed cards whose `due_at` has passed. Returns null when no such deck exists for this student.
 *
 * Cards a student already reviewed but is not due for yet are intentionally absent -- the review
 * endpoint is a study session, not a deck listing, so "what do I study now" is the whole contract.
 */
export async function loadDueCards(
  tx: TransactionSql,
  input: { deckId: string; studentId: string; limit: number; now: Date },
): Promise<DeckReview | null> {
  const [deck] = await tx<{ id: string }[]>`
    SELECT id FROM app.flashcard_decks
    WHERE id = ${input.deckId}::uuid AND student_id = ${input.studentId}::uuid
  `;
  if (!deck) return null;

  const rows = await tx<
    {
      id: string;
      card_order: number;
      card_type: FlashcardType;
      front: string;
      back: string;
      material_chunk_id: string;
      material_id: string;
      material_title: string | null;
      page_number: number | null;
      section_title: string | null;
      interval_days: number | null;
      ease_factor: number | null;
      repetitions: number | null;
      due_at: Date | null;
    }[]
  >`
    SELECT
      f.id, f.card_order, f.card_type, f.front, f.back,
      f.material_chunk_id, mc.material_id, m.title AS material_title,
      mc.page_number, mc.section_title,
      r.interval_days, r.ease_factor::float8 AS ease_factor, r.repetitions, r.due_at
    FROM app.flashcards f
    LEFT JOIN app.flashcard_reviews r
      ON r.card_id = f.id AND r.school_id = f.school_id AND r.student_id = ${input.studentId}::uuid
    JOIN app.material_chunks mc ON mc.id = f.material_chunk_id
    JOIN app.materials m ON m.id = mc.material_id
    WHERE f.deck_id = ${deck.id}::uuid
      AND (r.id IS NULL OR r.due_at <= ${input.now})
    ORDER BY f.card_order ASC
    LIMIT ${input.limit}
  `;

  return {
    deckId: deck.id,
    cards: rows.map((row) => ({
      id: row.id,
      order: row.card_order,
      type: row.card_type,
      front: row.front,
      back: row.back,
      citation: {
        chunkId: row.material_chunk_id,
        materialId: row.material_id,
        materialTitle: row.material_title,
        pageNumber: row.page_number,
        sectionTitle: row.section_title,
      },
      progress:
        row.due_at === null
          ? null
          : {
              intervalDays: row.interval_days!,
              easeFactor: row.ease_factor!,
              repetitions: row.repetitions!,
              dueAt: row.due_at,
            },
    })),
  };
}

// ---------------------------------------------------------------------------------------------------
// Review write path
// ---------------------------------------------------------------------------------------------------

export interface ReviewUpdate {
  cardId: string;
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
  dueAt: Date;
}

export interface ApplyCardReviewsInput {
  schoolId: string;
  studentId: string;
  /** The rating instant, used for `last_rated_at` and `updated_at` so the whole request is timestamped together. */
  ratedAt: Date;
  reviews: readonly ReviewUpdate[];
}

/**
 * Store one request's review outcomes, one row per student-card.
 *
 * Upserts on `(school_id, student_id, card_id)`: a first review inserts the schedule, every later
 * review overwrites it -- the state-row design that keeps the "due next" read to a single row per
 * card. `review_count` is the one lifetime field and is incremented on every write, so progress
 * tracking ("how many times has this student reviewed this card") needs no review-history table.
 */
export async function applyCardReviews(
  tx: TransactionSql,
  input: ApplyCardReviewsInput,
): Promise<void> {
  // Sequential upsert, one card at a time -- the same bounded-loop shape as persistDeck above.
  for (const review of input.reviews) {
    await tx`
      INSERT INTO app.flashcard_reviews (
        school_id, student_id, card_id,
        interval_days, ease_factor, repetitions, due_at,
        review_count, last_rated_at, updated_at
      ) VALUES (
        ${input.schoolId}::uuid, ${input.studentId}::uuid, ${review.cardId}::uuid,
        ${review.intervalDays}, ${review.easeFactor}, ${review.repetitions}, ${review.dueAt},
        1, ${input.ratedAt}, ${input.ratedAt}
      )
      ON CONFLICT (school_id, student_id, card_id) DO UPDATE SET
        interval_days = EXCLUDED.interval_days,
        ease_factor = EXCLUDED.ease_factor,
        repetitions = EXCLUDED.repetitions,
        due_at = EXCLUDED.due_at,
        review_count = app.flashcard_reviews.review_count + 1,
        last_rated_at = EXCLUDED.last_rated_at,
        updated_at = EXCLUDED.updated_at
    `;
  }
}
