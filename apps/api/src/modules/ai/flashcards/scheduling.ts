/**
 * Spaced-repetition scheduling for flashcards (ST-168) -- SM-2.
 *
 * `scheduleCard` is a pure function of the card's current progress, the student's rating, and the
 * review instant: same inputs, same output, every time -- no model call, no randomness, no clock.
 * That purity is the acceptance criterion "review schedule advances per algorithm": the arithmetic
 * is deterministic and unit-tested in isolation, and the review route feeds it the persisted
 * progress and a single `now`.
 *
 * The algorithm is the classic SM-2 from SuperMemo, with a 4-point rating scale mapped onto SM-2's
 * 0-5 quality: `again` = 1 (fail), `hard` = 3, `good` = 4, `easy` = 5 (pass). A pass keeps the
 * interval ladder 1 day -> 6 days -> `round(interval * ease_factor)`; a fail resets repetitions to
 * 0 and the next interval to 1 day. The ease factor updates on every review --
 * `EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))`, floored at 1.3 -- so `good` leaves it
 * unchanged, `easy` raises it, and `hard`/`again` lower it.
 *
 * Honest limits, matching the source algorithm: `hard`/`good`/`easy` differ only in their ease
 * factor, not in today's interval (classic SM-2 has no separate hard step); a card that was
 * scheduled `again` becomes due again tomorrow, it does not leave the deck. The review route's
 * persistence (`flashcards/persistence.ts`) stores exactly the fields this returns, and the
 * database re-asserts the same bounds (`ck_flashcard_reviews_*` in migration 000101) independently.
 */

export const FLASHCARD_RATINGS = ["again", "hard", "good", "easy"] as const;
export type FlashcardRating = (typeof FLASHCARD_RATINGS)[number];

export const FLASHCARD_DEFAULT_EASE_FACTOR = 2.5;
const SM2_MIN_EASE_FACTOR = 1.3;
const SM2_FIRST_INTERVAL_DAYS = 1;
const SM2_SECOND_INTERVAL_DAYS = 6;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** SM-2 quality for each rating: again fails (q < 3), the other three pass. */
const SM2_QUALITY: Record<FlashcardRating, number> = {
  again: 1,
  hard: 3,
  good: 4,
  easy: 5,
};

/** A card's current SM-2 state, as persisted per student per card. */
export interface FlashcardProgress {
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
}

export interface ScheduledReview {
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
  /** The next time this card is due: `now` plus `intervalDays` whole days. */
  dueAt: Date;
}

function roundEaseFactor(easeFactor: number): number {
  return Math.round(easeFactor * 100) / 100;
}

/**
 * Advance a card's schedule after one review.
 *
 * @param progress the card's current SM-2 state, or null for a card that has never been reviewed
 *   (the review route calls this with null for a fresh card).
 * @param rating the student's self-graded rating for this review.
 * @param now the review instant; the returned `dueAt` is `now` plus the new interval.
 */
export function scheduleCard(
  progress: FlashcardProgress | null,
  rating: FlashcardRating,
  now: Date,
): ScheduledReview {
  const quality = SM2_QUALITY[rating];
  const previousEase = progress?.easeFactor ?? FLASHCARD_DEFAULT_EASE_FACTOR;
  const previousInterval = progress?.intervalDays ?? 0;
  const previousRepetitions = progress?.repetitions ?? 0;

  const easeFactor = Math.max(
    SM2_MIN_EASE_FACTOR,
    previousEase + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)),
  );

  let repetitions: number;
  let intervalDays: number;

  if (quality < 3) {
    repetitions = 0;
    intervalDays = SM2_FIRST_INTERVAL_DAYS;
  } else if (previousRepetitions === 0) {
    repetitions = 1;
    intervalDays = SM2_FIRST_INTERVAL_DAYS;
  } else if (previousRepetitions === 1) {
    repetitions = 2;
    intervalDays = SM2_SECOND_INTERVAL_DAYS;
  } else {
    repetitions = previousRepetitions + 1;
    intervalDays = Math.round(previousInterval * easeFactor);
  }

  return {
    intervalDays,
    easeFactor: roundEaseFactor(easeFactor),
    repetitions,
    dueAt: new Date(now.getTime() + intervalDays * MS_PER_DAY),
  };
}
