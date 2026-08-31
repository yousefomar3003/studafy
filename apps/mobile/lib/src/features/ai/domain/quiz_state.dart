import 'quiz.dart';
import 'quiz_attempt.dart';

/// Why `QuizController.generate` couldn't produce a quiz. Mirrors [AskAiSendError]'s split
/// between the shared AI gate and this surface's own failure modes — the screen picks the
/// wording, the controller only classifies (see `ask_ai_conversation.dart`'s doc comment on
/// [AskAiSendError] for why that split exists).
enum QuizGenerateError {
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

  /// 503 `AI_QUIZ_GENERATION_FAILED` / `AI_LLM_UNAVAILABLE` / `AI_LLM_REQUEST_REJECTED` — the
  /// model's response didn't validate, or the provider failed. Retryable; the server doesn't
  /// distinguish these for the client's purposes, unlike Ask AI's stream, because generation
  /// never got far enough here to leave a partial answer worth telling apart.
  generationFailed,

  /// A connectivity problem — no response reached the client.
  network,

  /// Anything else.
  unknown,
}

/// The quiz screen's top-level state — one of three phases, the same "sealed one state per phase"
/// convention [AskAiConversation]'s answer states and `AiHubStatus` both use.
sealed class QuizState {
  const QuizState();
}

/// No quiz in play: pick materials and start one. The screen's landing state, and where
/// `QuizController.startNewQuiz` always returns to.
class QuizSetup extends QuizState {
  const QuizSetup({this.isGenerating = false, this.generateError});

  final bool isGenerating;
  final QuizGenerateError? generateError;

  QuizSetup copyWith({bool? isGenerating, QuizGenerateError? generateError, bool clearError = false}) {
    return QuizSetup(
      isGenerating: isGenerating ?? this.isGenerating,
      generateError: clearError ? null : (generateError ?? this.generateError),
    );
  }
}

/// A round in progress: [attempt.currentIndex] names the question on screen.
class QuizInProgress extends QuizState {
  const QuizInProgress({
    required this.quiz,
    required this.attempt,
    this.isGrading = false,
    this.gradeFailed = false,
  });

  final GeneratedQuiz quiz;
  final QuizAttempt attempt;

  /// True while the grade call triggered by the current question's answer is in flight.
  final bool isGrading;

  /// The most recent grade call failed (network, mainly). The answer is already saved locally —
  /// see `QuizProgressStore` — so nothing is lost; `QuizController.retryGrade` tries again.
  final bool gradeFailed;

  QuizInProgress copyWith({QuizAttempt? attempt, bool? isGrading, bool? gradeFailed}) {
    return QuizInProgress(
      quiz: quiz,
      attempt: attempt ?? this.attempt,
      isGrading: isGrading ?? this.isGrading,
      gradeFailed: gradeFailed ?? this.gradeFailed,
    );
  }
}

/// A round finished — every question in it has a revealed result. Shows the score, per-question
/// feedback, and (when [QuizAttempt.wrongQuestionIds] is non-empty) the retry-wrong-only action.
class QuizRoundResults extends QuizState {
  const QuizRoundResults({required this.quiz, required this.attempt});

  final GeneratedQuiz quiz;
  final QuizAttempt attempt;
}
