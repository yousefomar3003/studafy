/// Domain models for flashcard decks and their spaced-repetition review, mirroring the API's ST-168
/// surface (`apps/api/src/modules/ai/routes/flashcard-routes.ts`, `flashcards/scheduling.ts`).
///
/// `data/flashcard_client.dart` parses the wire (snake_case JSON) shapes into these; the widgets
/// never see raw JSON. [FlashcardProgress] is rendered, never recomputed — the scheduler is pure
/// SM-2 and lives server-side only (`docs/rag/flashcards-and-spaced-repetition.md`), so this app's
/// only job is to submit a rating and show back whatever schedule the server returns.
library;

/// `term_definition` | `q_a` — see `apps/api/src/modules/ai/flashcards/schema.ts`.
enum FlashcardType { termDefinition, qA }

String flashcardTypeToWire(FlashcardType type) => switch (type) {
  FlashcardType.termDefinition => 'term_definition',
  FlashcardType.qA => 'q_a',
};

FlashcardType flashcardTypeFromWire(String wire) => switch (wire) {
  'q_a' => FlashcardType.qA,
  _ => FlashcardType.termDefinition,
};

/// The 4-point self-graded scale `flashcards/scheduling.ts`'s SM-2 implementation maps onto SM-2
/// quality: `again` fails the card, the other three pass it at increasing quality.
enum FlashcardRating { again, hard, good, easy }

String flashcardRatingToWire(FlashcardRating rating) => switch (rating) {
  FlashcardRating.again => 'again',
  FlashcardRating.hard => 'hard',
  FlashcardRating.good => 'good',
  FlashcardRating.easy => 'easy',
};

FlashcardRating flashcardRatingFromWire(String wire) => switch (wire) {
  'again' => FlashcardRating.again,
  'hard' => FlashcardRating.hard,
  'easy' => FlashcardRating.easy,
  _ => FlashcardRating.good,
};

/// A resolved pointer from a card back to the material chunk it was grounded on. Every flashcard
/// carries exactly one, the same one-citation-per-row posture quiz questions take.
class FlashcardCitation {
  const FlashcardCitation({
    required this.chunkId,
    required this.materialId,
    this.materialTitle,
    this.pageNumber,
    this.sectionTitle,
  });

  final String chunkId;
  final String materialId;
  final String? materialTitle;

  /// 1-based page (PDF) or slide, or null when the material has no paginated structure.
  final int? pageNumber;
  final String? sectionTitle;
}

/// A student's current SM-2 schedule for one card, as returned by the review endpoints. Null on a
/// card that has never been reviewed — see [FlashcardCard.progress].
class FlashcardProgress {
  const FlashcardProgress({
    required this.intervalDays,
    required this.easeFactor,
    required this.repetitions,
    required this.dueAt,
  });

  final int intervalDays;
  final double easeFactor;
  final int repetitions;
  final DateTime dueAt;
}

/// One flashcard: its faces, citation, and — once fetched from the review endpoint — the
/// student's current schedule. [progress] is always null on a freshly generated deck (every card
/// is due until its first review; see `generateDeck`'s response, which carries no progress field
/// at all).
class FlashcardCard {
  const FlashcardCard({
    required this.id,
    required this.order,
    required this.type,
    required this.front,
    required this.back,
    required this.citation,
    this.progress,
  });

  final String id;

  /// 1-based position within the deck.
  final int order;
  final FlashcardType type;
  final String front;
  final String back;
  final FlashcardCitation citation;
  final FlashcardProgress? progress;
}

/// A freshly generated deck: `POST /api/ai/students/{id}/decks`'s response. Every card is
/// studyable immediately, so a review session can start straight from this without a round trip
/// to the due-cards endpoint.
class GeneratedDeck {
  const GeneratedDeck({required this.deckId, required this.cards});

  final String deckId;

  /// In generation order (`FlashcardCard.order` ascending).
  final List<FlashcardCard> cards;
}

/// `GET .../decks/{deckId}/review`'s response: the deck's cards due right now.
class DueCards {
  const DueCards({required this.deckId, required this.cards});

  final String deckId;
  final List<FlashcardCard> cards;

  int get dueCount => cards.length;
}

/// One card's new schedule from `POST .../decks/{deckId}/review` — what now governs when it
/// becomes due again.
class FlashcardReviewOutcome {
  const FlashcardReviewOutcome({
    required this.cardId,
    required this.rating,
    required this.intervalDays,
    required this.easeFactor,
    required this.repetitions,
    required this.dueAt,
  });

  final String cardId;
  final FlashcardRating rating;
  final int intervalDays;
  final double easeFactor;
  final int repetitions;
  final DateTime dueAt;
}
