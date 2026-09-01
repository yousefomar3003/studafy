import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../../core/api/api_exception.dart';
import '../data/flashcard_client.dart';
import '../data/flashcard_library_store.dart';
import '../domain/flashcard.dart';
import '../domain/flashcard_deck_summary.dart';
import '../domain/flashcard_state.dart';

/// Drives the flashcard feature end to end: the deck browser (generation plus each deck's live
/// due-today count and the review streak) and one deck's review session (swipe/tap grading, one
/// card at a time, synced to the server immediately) — folding `FlashcardClient`'s responses into
/// the [FlashcardScreenState] the screen renders.
///
/// Unlike `QuizController`, this keeps no local session cache for "resume after restart": every
/// rating syncs to the server the moment it's given (`rate`), and the server's own due-cards list
/// is the resume mechanism — a card that was just rated is no longer due, so relaunching the app
/// and starting a new session on the same deck naturally picks up with whatever is left. That's
/// what makes "progress syncs" concrete here rather than a local cache the review endpoints have
/// no way to reconcile against.
///
/// A plain [ChangeNotifier], not a Riverpod provider — same call as `QuizController`: this state
/// belongs to exactly one screen and is read nowhere else. Created in the screen's `State` and
/// disposed with it.
class FlashcardController extends ChangeNotifier {
  FlashcardController({
    required FlashcardClient client,
    required FlashcardLibraryStore libraryStore,
    required String studentId,
  }) : _client = client,
       _libraryStore = libraryStore,
       _studentId = studentId;

  final FlashcardClient _client;
  final FlashcardLibraryStore _libraryStore;
  final String _studentId;

  FlashcardScreenState _state = const FlashcardLibrary(decks: [], streak: 0);
  FlashcardScreenState get state => _state;

  void _emit(FlashcardScreenState next) {
    _state = next;
    notifyListeners();
  }

  /// Loads the locally-tracked deck list and streak, then resolves each deck's due-today count in
  /// the background. Call once, right after construction.
  Future<void> restore() async {
    final decks = await _libraryStore.loadDecks(_studentId);
    final streak = await _libraryStore.loadStreak(_studentId);
    _emit(
      FlashcardLibrary(
        decks: [for (final deck in decks) FlashcardDeckEntry(summary: deck)],
        streak: streak,
      ),
    );
    await refreshDueCounts();
  }

  /// Re-fetches every deck's due-today count in parallel. Safe to call repeatedly (pull-to-refresh,
  /// or after returning from a session); a no-op unless the browser is showing.
  Future<void> refreshDueCounts() async {
    final current = _state;
    if (current is! FlashcardLibrary) return;

    final resolved = await Future.wait(
      current.decks.map((entry) async {
        try {
          final due = await _client.dueCards(studentId: _studentId, deckId: entry.summary.deckId);
          return entry.copyWith(dueCount: due.dueCount, dueCountFailed: false);
        } catch (_) {
          return entry.copyWith(dueCountFailed: true);
        }
      }),
    );

    final stillCurrent = _state;
    if (stillCurrent is! FlashcardLibrary) return;
    _emit(stillCurrent.copyWith(decks: resolved));
  }

  /// Generates a deck from [materialIds] and records it in the browser. [materialTitles] is a
  /// same-length, same-order snapshot for the deck tile's label — the browser has no material
  /// lookup of its own (see [FlashcardDeckSummary]). No-op while already generating, with no
  /// materials selected, over the material cap, or with a [cardCount] outside the server's
  /// accepted range.
  Future<void> generateDeck({
    required List<String> materialIds,
    required List<String> materialTitles,
    int? cardCount,
  }) async {
    final current = _state;
    if (current is! FlashcardLibrary || current.isGenerating) return;
    if (materialIds.isEmpty || materialIds.length > flashcardMaxMaterials) return;
    if (cardCount != null && (cardCount < flashcardMinCards || cardCount > flashcardMaxCards)) {
      return;
    }

    _emit(current.copyWith(isGenerating: true, clearError: true));

    try {
      final deck = await _client.generateDeck(
        studentId: _studentId,
        materialIds: materialIds,
        cardCount: cardCount,
      );
      final summary = FlashcardDeckSummary(
        deckId: deck.deckId,
        generatedAt: DateTime.now(),
        cardCount: deck.cards.length,
        materialTitles: materialTitles,
      );
      await _libraryStore.addDeck(_studentId, summary);

      // The generate response carries no progress field: every card is due until its first
      // review, so this starts the session directly rather than round-tripping to the due-cards
      // endpoint for a list that would be identical.
      _emit(FlashcardReviewSession(deckId: deck.deckId, cards: deck.cards));
    } on DioException catch (error) {
      _emit(current.copyWith(isGenerating: false, generateError: _classifyGenerateError(error)));
    } catch (_) {
      _emit(
        current.copyWith(isGenerating: false, generateError: FlashcardGenerateError.unknown),
      );
    }
  }

  /// Starts a review session for an existing deck's due cards. Returns false (leaving the browser
  /// state untouched) on failure, so the screen can show a transient error without losing the
  /// deck list.
  Future<bool> startSession(String deckId) async {
    if (_state is! FlashcardLibrary) return false;
    try {
      final due = await _client.dueCards(studentId: _studentId, deckId: deckId);
      _emit(FlashcardReviewSession(deckId: due.deckId, cards: due.cards));
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Flips the current card to its back face. No-op once already revealed, or with no card
  /// showing (an empty due list).
  void revealAnswer() {
    final current = _state;
    if (current is! FlashcardReviewSession || current.revealed || current.currentCard == null) {
      return;
    }
    _emit(current.copyWith(revealed: true));
  }

  /// Grades the current card [rating] and syncs it immediately. No-op unless the card is revealed
  /// and no submit is already in flight. Advances to the next card, or — from the last card —
  /// ends the session, only once the sync actually succeeds; a failure leaves the card revealed
  /// with [FlashcardReviewSession.syncFailedRating] set so [retrySync] can pick it up.
  Future<void> rate(FlashcardRating rating) async {
    final current = _state;
    if (current is! FlashcardReviewSession || !current.revealed || current.isSubmitting) return;
    final card = current.currentCard;
    if (card == null) return;

    _emit(current.copyWith(isSubmitting: true, clearSyncFailed: true));

    try {
      final outcome = await _client.submitReview(
        studentId: _studentId,
        deckId: current.deckId,
        cardId: card.id,
        rating: rating,
      );
      await _libraryStore.recordReviewToday(_studentId);
      final outcomes = {...current.outcomes, card.id: outcome};

      if (current.isLastCard) {
        _emit(FlashcardSessionComplete(deckId: current.deckId, outcomes: outcomes.values.toList()));
        return;
      }

      _emit(
        current.copyWith(
          currentIndex: current.currentIndex + 1,
          revealed: false,
          outcomes: outcomes,
          isSubmitting: false,
        ),
      );
    } catch (_) {
      _emit(current.copyWith(isSubmitting: false, syncFailedRating: rating));
    }
  }

  /// Re-submits the rating that failed to sync. No-op unless the current card actually has a
  /// failed sync to retry.
  Future<void> retrySync() async {
    final current = _state;
    if (current is! FlashcardReviewSession) return;
    final failedRating = current.syncFailedRating;
    if (failedRating == null) return;
    await rate(failedRating);
  }

  /// Returns to the deck browser, reloading it fresh — from an in-progress session (abandoning
  /// whatever wasn't yet rated; nothing server-side needs cleanup, since every synced rating
  /// already landed) or from a finished session's summary.
  Future<void> backToLibrary() async {
    if (_state is! FlashcardReviewSession && _state is! FlashcardSessionComplete) return;
    await restore();
  }

  FlashcardGenerateError _classifyGenerateError(DioException error) {
    final apiError = error.apiError;
    if (apiError != null) {
      return switch (apiError.code) {
        'AI_QUOTA_EXCEEDED' => FlashcardGenerateError.quotaExceeded,
        'AI_SUBSCRIPTION_INACTIVE' => FlashcardGenerateError.subscriptionInactive,
        'AI_SCHOOL_INACTIVE' => FlashcardGenerateError.schoolInactive,
        'AI_LLM_DISABLED' => FlashcardGenerateError.llmDisabled,
        'RESOURCE_NOT_FOUND' => FlashcardGenerateError.materialNotFound,
        'VALIDATION_FAILED' => FlashcardGenerateError.materialNotReady,
        'AI_FLASHCARD_GENERATION_FAILED' ||
        'AI_LLM_UNAVAILABLE' ||
        'AI_LLM_REQUEST_REJECTED' => FlashcardGenerateError.generationFailed,
        _ => FlashcardGenerateError.unknown,
      };
    }
    return switch (error.type) {
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout ||
      DioExceptionType.connectionError => FlashcardGenerateError.network,
      _ => FlashcardGenerateError.unknown,
    };
  }
}
