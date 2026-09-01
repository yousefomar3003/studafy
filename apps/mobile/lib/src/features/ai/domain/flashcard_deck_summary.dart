/// The deck browser's local registry entry (`data/flashcard_library_store.dart`).
///
/// There is no `GET /api/ai/students/{id}/decks` — the API lists a *deck's* due cards
/// (`GET .../decks/{deckId}/review`) but never lists a *student's* decks — so the browser can only
/// show decks this device has itself generated, recorded the moment `generateDeck` returns. This
/// mirrors the precedent `QuizProgressStore` documents for quiz sessions: not a cache of a server
/// resource, because there is no server resource to cache.
class FlashcardDeckSummary {
  const FlashcardDeckSummary({
    required this.deckId,
    required this.generatedAt,
    required this.cardCount,
    required this.materialTitles,
  });

  final String deckId;
  final DateTime generatedAt;
  final int cardCount;

  /// Titles of the materials the deck was generated from, snapshotted at generation time purely
  /// for display — the browser has no material lookup of its own.
  final List<String> materialTitles;

  Map<String, Object?> toJson() => {
    'deckId': deckId,
    'generatedAt': generatedAt.toIso8601String(),
    'cardCount': cardCount,
    'materialTitles': materialTitles,
  };

  factory FlashcardDeckSummary.fromJson(Map<String, Object?> json) => FlashcardDeckSummary(
    deckId: json['deckId']! as String,
    generatedAt: DateTime.parse(json['generatedAt']! as String),
    cardCount: json['cardCount']! as int,
    materialTitles: (json['materialTitles']! as List<Object?>).cast<String>(),
  );
}
