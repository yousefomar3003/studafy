import 'flashcard.dart';
import 'flashcard_deck_summary.dart';

/// Why `FlashcardController.generateDeck` couldn't produce a deck. Mirrors `QuizGenerateError` —
/// same gate, same material-loader failure modes, just the flashcard-specific generation-failed
/// code in place of the quiz one.
enum FlashcardGenerateError {
  /// 429 `AI_QUOTA_EXCEEDED` — the student's monthly AI token budget is spent.
  quotaExceeded,

  /// 402 `AI_SUBSCRIPTION_INACTIVE` — the school's AI add-on isn't active.
  subscriptionInactive,

  /// 403 `AI_SCHOOL_INACTIVE` — the school's subscription lapsed.
  schoolInactive,

  /// 503 `AI_LLM_DISABLED` — the AI plane is switched off server-side.
  llmDisabled,

  /// 404 `RESOURCE_NOT_FOUND` — a selected material doesn't exist or isn't visible to this school.
  materialNotFound,

  /// 422 `VALIDATION_FAILED` — a selected material is still mid-ingestion (no text yet).
  materialNotReady,

  /// 503 `AI_FLASHCARD_GENERATION_FAILED` / `AI_LLM_UNAVAILABLE` / `AI_LLM_REQUEST_REJECTED` — the
  /// model's response didn't validate, or the provider failed. Retryable.
  generationFailed,

  /// A connectivity problem — no response reached the client.
  network,

  /// Anything else.
  unknown,
}

/// One deck in the browser: its local summary plus how many of its cards are due right now.
/// [dueCount] is null while that count is loading or failed to load — the tile shows a neutral
/// state rather than a wrong number.
class FlashcardDeckEntry {
  const FlashcardDeckEntry({required this.summary, this.dueCount, this.dueCountFailed = false});

  final FlashcardDeckSummary summary;
  final int? dueCount;
  final bool dueCountFailed;

  FlashcardDeckEntry copyWith({int? dueCount, bool? dueCountFailed}) => FlashcardDeckEntry(
    summary: summary,
    dueCount: dueCount ?? this.dueCount,
    dueCountFailed: dueCountFailed ?? this.dueCountFailed,
  );
}

/// The flashcards screen's top-level state — one of three phases, the same "sealed one state per
/// phase" convention `QuizState` uses.
sealed class FlashcardScreenState {
  const FlashcardScreenState();
}

/// The deck browser: every deck this device has generated, each with its due-today count, plus
/// the review streak. The screen's landing state.
class FlashcardLibrary extends FlashcardScreenState {
  const FlashcardLibrary({
    required this.decks,
    required this.streak,
    this.isGenerating = false,
    this.generateError,
  });

  /// Most recently generated first.
  final List<FlashcardDeckEntry> decks;

  /// Consecutive days (ending today or yesterday) with at least one synced review.
  final int streak;
  final bool isGenerating;
  final FlashcardGenerateError? generateError;

  FlashcardLibrary copyWith({
    List<FlashcardDeckEntry>? decks,
    int? streak,
    bool? isGenerating,
    FlashcardGenerateError? generateError,
    bool clearError = false,
  }) {
    return FlashcardLibrary(
      decks: decks ?? this.decks,
      streak: streak ?? this.streak,
      isGenerating: isGenerating ?? this.isGenerating,
      generateError: clearError ? null : (generateError ?? this.generateError),
    );
  }
}

/// A study session in progress: due cards for one deck, reviewed one at a time. [cards] can be
/// empty — every due card was already reviewed elsewhere, or the deck had none due — which the
/// view renders as "nothing due" rather than treating as an error.
class FlashcardReviewSession extends FlashcardScreenState {
  const FlashcardReviewSession({
    required this.deckId,
    required this.cards,
    this.currentIndex = 0,
    this.revealed = false,
    this.outcomes = const {},
    this.isSubmitting = false,
    this.syncFailedRating,
  });

  final String deckId;

  /// This session's due cards, in the order the review endpoint returned them.
  final List<FlashcardCard> cards;
  final int currentIndex;

  /// Whether the current card's back face is showing. Rating is only possible once revealed —
  /// grading a card you haven't read the answer to isn't a real self-assessment.
  final bool revealed;

  /// cardId -> the schedule the server returned once that card's rating synced.
  final Map<String, FlashcardReviewOutcome> outcomes;
  final bool isSubmitting;

  /// The rating that failed to sync for the current card, if any — `null` when the last submit
  /// (or none has been attempted yet) succeeded. The answer stays revealed and the rating buttons
  /// stay live so the student can retry without losing their place, the same posture
  /// `QuizInProgress.gradeFailed` takes.
  final FlashcardRating? syncFailedRating;

  FlashcardCard? get currentCard => currentIndex < cards.length ? cards[currentIndex] : null;
  bool get isLastCard => currentIndex >= cards.length - 1;
  int get reviewedCount => outcomes.length;

  FlashcardReviewSession copyWith({
    int? currentIndex,
    bool? revealed,
    Map<String, FlashcardReviewOutcome>? outcomes,
    bool? isSubmitting,
    FlashcardRating? syncFailedRating,
    bool clearSyncFailed = false,
  }) {
    return FlashcardReviewSession(
      deckId: deckId,
      cards: cards,
      currentIndex: currentIndex ?? this.currentIndex,
      revealed: revealed ?? this.revealed,
      outcomes: outcomes ?? this.outcomes,
      isSubmitting: isSubmitting ?? this.isSubmitting,
      syncFailedRating: clearSyncFailed ? null : (syncFailedRating ?? this.syncFailedRating),
    );
  }
}

/// A session finished — every due card has a synced outcome. Shows the tally and returns to the
/// browser on demand.
class FlashcardSessionComplete extends FlashcardScreenState {
  const FlashcardSessionComplete({required this.deckId, required this.outcomes});

  final String deckId;
  final List<FlashcardReviewOutcome> outcomes;

  int countOf(FlashcardRating rating) =>
      outcomes.where((outcome) => outcome.rating == rating).length;
}
