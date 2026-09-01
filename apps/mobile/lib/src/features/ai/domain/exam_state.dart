import 'exam.dart';
import 'exam_session.dart';

/// Why `ExamController.create` couldn't start generating an exam. Mirrors [QuizGenerateError]'s
/// split between the shared AI gate and this surface's own failure modes, minus
/// `generationFailed`: exam generation runs on a worker, off the request path, so a bad model
/// response surfaces later as [ExamFailed] instead of as a create-time exception.
enum ExamCreateError {
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

  /// 503 `AI_EXAM_GENERATION_UNAVAILABLE` — the generation queue isn't configured, or enqueueing
  /// the job failed.
  generationUnavailable,

  /// A connectivity problem — no response reached the client.
  network,

  /// Anything else.
  unknown,
}

/// Why `ExamController.submit` didn't score the exam. Deliberately small: `AI_EXAM_NOT_FOUND` /
/// `AI_EXAM_INVALID_STATE` / `VALIDATION_FAILED` can only happen from a bug in this controller's
/// own state machine (submitting twice, naming an item outside the session), not from anything a
/// student did, so they fold into [unknown] rather than each getting user-facing copy.
enum ExamSubmitError {
  /// 409 `AI_EXAM_EXPIRED` — the server's clock passed `expiresAt` before this submission landed.
  /// The server-side timer enforcement that makes the countdown tamper-resistant: nothing the
  /// client does can undo this once it happens.
  expired,

  /// A connectivity problem — no response reached the client. The answer draft is untouched, so
  /// retrying costs nothing.
  network,

  /// Anything else.
  unknown,
}

/// The exam screen's top-level state — one of five phases mirroring [ExamSessionStatus] plus the
/// pre-session setup step, the same "sealed one state per phase" convention [QuizState] uses.
sealed class ExamState {
  const ExamState();
}

/// No exam in play: pick materials, question count, and duration, then create a session. The
/// screen's landing state, and where `ExamController.startNewExam` always returns to.
class ExamSetup extends ExamState {
  const ExamSetup({this.isCreating = false, this.createError, this.restoreFailed = false});

  final bool isCreating;
  final ExamCreateError? createError;

  /// A previously-started exam exists (its id is saved locally) but resuming it failed for a
  /// reason other than the session being gone (network, most likely) — the draft is kept, not
  /// discarded, so `ExamController.restore` can be called again once connectivity is back rather
  /// than the student silently losing a paid-for exam session.
  final bool restoreFailed;

  ExamSetup copyWith({bool? isCreating, ExamCreateError? createError, bool clearError = false}) {
    return ExamSetup(
      isCreating: isCreating ?? this.isCreating,
      createError: clearError ? null : (createError ?? this.createError),
    );
  }
}

/// The item bank is still generating on a worker. No countdown yet — the timer only starts once
/// the student deliberately begins the exam from [ExamReady].
class ExamGenerating extends ExamState {
  const ExamGenerating({required this.session});

  final ExamSession session;
}

/// Generated and waiting on the student's deliberate "start" — the "lock-in start" moment
/// acceptance criteria call for: nothing about the timer begins until this screen's action is
/// taken, and no items are visible before then either.
class ExamReady extends ExamState {
  const ExamReady({required this.session, this.isStarting = false, this.startFailed = false});

  final ExamSession session;
  final bool isStarting;
  final bool startFailed;

  ExamReady copyWith({bool? isStarting, bool? startFailed}) => ExamReady(
    session: session,
    isStarting: isStarting ?? this.isStarting,
    startFailed: startFailed ?? this.startFailed,
  );
}

/// The timed player: [session.expiresAt] is the server-authoritative deadline, [currentIndex]
/// names the item on screen, and [answers] is the not-yet-submitted draft (mirrored to
/// `ExamProgressStore` after every change so an interrupted app can resume exactly here).
class ExamInProgress extends ExamState {
  const ExamInProgress({
    required this.session,
    this.answers = const {},
    this.currentIndex = 0,
    this.isSubmitting = false,
    this.submitError,
  });

  /// Status `inProgress`; [ExamSession.items] and [ExamSession.expiresAt] are always non-null
  /// here — `ExamController` never emits this state without both populated.
  final ExamSession session;

  /// itemId -> submitted answer: the chosen option id for `mcq`, the typed text for
  /// `short_answer`. Unlike quiz, nothing is graded until [ExamController.submit] — exam mode is
  /// one final submission, not per-question feedback.
  final Map<String, String> answers;
  final int currentIndex;

  /// True while the one-shot grade-and-report call is in flight.
  final bool isSubmitting;
  final ExamSubmitError? submitError;

  List<ExamItem> get items => session.items!;
  ExamItem get currentItem => items[currentIndex];
  int get itemCount => items.length;
  bool get isLastItem => currentIndex >= itemCount - 1;
  int get answeredCount => answers.length;

  ExamInProgress copyWith({
    Map<String, String>? answers,
    int? currentIndex,
    bool? isSubmitting,
    ExamSubmitError? submitError,
    bool clearSubmitError = false,
  }) {
    return ExamInProgress(
      session: session,
      answers: answers ?? this.answers,
      currentIndex: currentIndex ?? this.currentIndex,
      isSubmitting: isSubmitting ?? this.isSubmitting,
      submitError: clearSubmitError ? null : (submitError ?? this.submitError),
    );
  }
}

/// Graded: [session.report] has the score and per-topic weak-study links.
class ExamSubmitted extends ExamState {
  const ExamSubmitted({required this.session});

  final ExamSession session;
}

/// Generation failed on the worker — [session.failureReason] is an internal diagnostic string,
/// not shown to the student; the screen renders a generic message instead.
class ExamFailed extends ExamState {
  const ExamFailed({required this.session});

  final ExamSession session;
}
