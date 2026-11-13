import 'package:dio/dio.dart';

import '../domain/flashcard.dart';

/// Client for the flashcard deck and spaced-repetition review surface — hand-called rather than
/// the generated `StudafyApiClient`, the same call `QuizClient`'s doc comment explains: the `AI`
/// tag is excluded from the mobile OpenAPI codegen (see `pubspec.yaml`'s `swagger_parser.exclude_tags`),
/// so every `/api/ai/*` surface is a hand-written Dio client instead.
///
/// Concrete rather than an interface, matching `QuizClient`; tests substitute it via
/// `implements FlashcardClient`, overridden through `flashcardClientProvider`.
class FlashcardClient {
  FlashcardClient(this._dio);

  final Dio _dio;

  /// Generates a deck from [materialIds] (1-5 materials, no duplicates). [cardCount] defaults to
  /// the server's own default (`AI_FLASHCARD_DEFAULT_CARDS`) when null.
  ///
  /// Throws [ApiException]-carrying [DioException] (via `ErrorMappingInterceptor`) for every
  /// failure mode `flashcard-routes.ts` documents: the shared AI gate (403/402/429), a material
  /// the school can't see or with no ingested text (404), a material still mid-ingestion (422),
  /// the LLM kill switch or provider failure taxonomy (503), and a model response that failed
  /// schema validation (503 `AI_FLASHCARD_GENERATION_FAILED`).
  Future<GeneratedDeck> generateDeck({
    required String studentId,
    required List<String> materialIds,
    int? cardCount,
  }) async {
    final payload = <String, Object?>{'materialIds': materialIds};
    if (cardCount != null) payload['cardCount'] = cardCount;

    final response = await _dio.post<Map<String, Object?>>(
      '/api/ai/students/$studentId/decks',
      data: payload,
    );
    final body = response.data!;
    final cards = (body['cards']! as List<Object?>)
        .map((card) => _parseCard(card! as Map<String, Object?>))
        .toList();
    return GeneratedDeck(deckId: body['deck_id']! as String, cards: cards);
  }

  /// The deck's cards due right now: never-reviewed cards plus reviewed cards whose schedule has
  /// come due. Draws no LLM tokens. Throws 404 `AI_FLASHCARD_DECK_NOT_FOUND` for a deck that
  /// doesn't exist or belongs to a different student.
  Future<DueCards> dueCards({required String studentId, required String deckId}) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/ai/students/$studentId/decks/$deckId/review',
    );
    final body = response.data!;
    final cards = (body['cards']! as List<Object?>)
        .map((card) => _parseCard(card! as Map<String, Object?>))
        .toList();
    return DueCards(deckId: body['deck_id']! as String, cards: cards);
  }

  /// Submits one self-graded rating and returns that card's new SM-2 schedule. The endpoint
  /// accepts a batch (`reviews: [...]`, up to `AI_FLASHCARD_REVIEW_LIMIT`), but the review screen
  /// grades one card at a time and syncs each rating immediately — see `FlashcardController` — so
  /// this always sends a single-entry batch.
  ///
  /// Draws no LLM tokens. Throws 404 `AI_FLASHCARD_DECK_NOT_FOUND` for a deck that doesn't exist
  /// or belongs to a different student, and 422 `VALIDATION_FAILED` for a card outside the deck or
  /// a duplicate review of the same card.
  Future<FlashcardReviewOutcome> submitReview({
    required String studentId,
    required String deckId,
    required String cardId,
    required FlashcardRating rating,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/ai/students/$studentId/decks/$deckId/review',
      data: {
        'reviews': [
          {'card_id': cardId, 'rating': flashcardRatingToWire(rating)},
        ],
      },
    );
    final results = response.data!['results']! as List<Object?>;
    return _parseOutcome(results.single! as Map<String, Object?>);
  }

  FlashcardCard _parseCard(Map<String, Object?> json) {
    final progressJson = json['progress'] as Map<String, Object?>?;
    return FlashcardCard(
      id: json['id']! as String,
      order: json['order']! as int,
      type: flashcardTypeFromWire(json['type']! as String),
      front: json['front']! as String,
      back: json['back']! as String,
      citation: _parseCitation(json['citation']! as Map<String, Object?>),
      progress: progressJson == null ? null : _parseProgress(progressJson),
    );
  }

  FlashcardCitation _parseCitation(Map<String, Object?> json) => FlashcardCitation(
    chunkId: json['chunk_id']! as String,
    materialId: json['material_id']! as String,
    materialTitle: json['material_title'] as String?,
    pageNumber: json['page_number'] as int?,
    sectionTitle: json['section_title'] as String?,
  );

  FlashcardProgress _parseProgress(Map<String, Object?> json) => FlashcardProgress(
    intervalDays: json['interval_days']! as int,
    easeFactor: (json['ease_factor']! as num).toDouble(),
    repetitions: json['repetitions']! as int,
    dueAt: DateTime.parse(json['due_at']! as String),
  );

  FlashcardReviewOutcome _parseOutcome(Map<String, Object?> json) => FlashcardReviewOutcome(
    cardId: json['card_id']! as String,
    rating: flashcardRatingFromWire(json['rating']! as String),
    intervalDays: json['interval_days']! as int,
    easeFactor: (json['ease_factor']! as num).toDouble(),
    repetitions: json['repetitions']! as int,
    dueAt: DateTime.parse(json['due_at']! as String),
  );
}
