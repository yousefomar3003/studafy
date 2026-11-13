import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../../core/api/api_exception.dart';
import '../data/exam_client.dart';
import '../data/exam_progress_store.dart';
import '../domain/exam.dart';
import '../domain/exam_draft.dart';
import '../domain/exam_session.dart';
import '../domain/exam_state.dart';

/// Mirrors `AI_EXAM_MIN_QUESTIONS` / `AI_EXAM_MAX_QUESTIONS` / `AI_EXAM_DEFAULT_QUESTIONS` and
/// `AI_EXAM_MIN_DURATION_MINUTES` / `AI_EXAM_MAX_DURATION_MINUTES` / `AI_EXAM_DEFAULT_DURATION_MINUTES`
/// (`packages/constants/src/ai-exam.ts`) so the setup step can't ask for values the server would
/// reject, and `AI_EXAM_MAX_MATERIALS` so the material picker caps selection at what one request
/// accepts.
const int examMinQuestions = 5;
const int examMaxQuestions = 40;
const int examDefaultQuestions = 20;
const int examMinDurationMinutes = 5;
const int examMaxDurationMinutes = 180;
const int examDefaultDurationMinutes = 30;
const int examMaxMaterials = 8;

/// First delay between [ExamClient.getExam] polls while a session is
/// [ExamSessionStatus.generating]. Each poll that still finds it generating doubles the delay, up
/// to [examGenerationPollMaxInterval]: most exams are ready within the first few polls, and a
/// longer one doesn't need checking every 3 s.
const Duration examGenerationPollInitialInterval = Duration(seconds: 3);

/// Ceiling on the backed-off generation poll delay.
const Duration examGenerationPollMaxInterval = Duration(seconds: 15);

/// How long (summed poll delays, i.e. foreground time) the controller keeps polling a generating
/// session on its own before stopping at [ExamGenerating.pollingStopped] and leaving the next
/// check to the student. Bounds what one open screen can cost if a generation job is stuck.
const Duration examGenerationPollWindow = Duration(minutes: 5);

/// How often to re-render the countdown (and check it against the deadline) while a session is
/// [ExamSessionStatus.inProgress]. Local only — no request is made per tick.
const Duration examCountdownTickInterval = Duration(seconds: 1);

/// First delay before re-sending a submission that failed with a network error or a 5xx after the
/// deadline passed. Doubles per retry up to [examSubmitRetryMaxDelay].
const Duration examSubmitRetryInitialDelay = Duration(seconds: 2);

/// Ceiling on the backed-off submit retry delay.
const Duration examSubmitRetryMaxDelay = Duration(seconds: 30);

/// How many automatic re-sends a failed post-deadline submission gets before the controller stops
/// and leaves the error on screen for the student to retry by hand.
const int examSubmitMaxRetries = 5;

/// Drives one exam session end to end (ST-232): setup, background generation, the deliberate
/// "lock-in start" that begins the server-enforced timer, timed play with a local answer draft,
/// submission (automatic once time runs out, or on demand), and the resulting report — folding
/// `ExamClient`'s responses into the [ExamState] the screen renders.
///
/// Unlike `QuizController`, this keeps no local cache of the session itself: every stage has a
/// `GET` endpoint the server can always answer fresh, so [restore] always re-fetches rather than
/// trusting a local copy. Only the answer draft — the one piece of state that exists nowhere on
/// the server until [submit] succeeds — is persisted, via [ExamProgressStore]. That split is what
/// makes "interruption recovery" concrete: an app restart at any lifecycle stage re-derives the
/// true state (still generating, ready to start, mid-countdown with `expiresAt` unaffected by the
/// gap, or already graded) from the server, and only replays the student's own unsent answers on
/// top of it.
///
/// A plain [ChangeNotifier], not a Riverpod provider — same call as `QuizController`: this state
/// belongs to exactly one screen for the life of one exam and is read nowhere else. Created in
/// the screen's `State` and disposed with it.
class ExamController extends ChangeNotifier {
  ExamController({
    required this._client,
    required this._progressStore,
    required this._studentId,
  });

  final ExamClient _client;
  final ExamProgressStore _progressStore;
  final String _studentId;

  ExamState _state = const ExamSetup();
  ExamState get state => _state;

  /// serverTime - deviceTime at the last response that carried a fresh server clock reading
  /// ([_client]'s `Date` header). Applied to the device's own clock to estimate "now" on the
  /// server's terms for the countdown display; [ExamClient.submitExam] is what actually enforces
  /// the deadline, so a stale or zero skew here only ever affects what the countdown shows, never
  /// whether a late submission is accepted.
  Duration _serverSkew = Duration.zero;

  Timer? _pollTimer;
  Timer? _countdownTimer;
  Timer? _submitRetryTimer;

  /// The delay the next generation poll will wait, and the total delay scheduled so far in the
  /// current polling window (compared against [examGenerationPollWindow]).
  Duration _pollDelay = examGenerationPollInitialInterval;
  Duration _pollElapsed = Duration.zero;

  /// True while a [ExamClient.getExam] generation check is awaiting its response, so a timer tick
  /// and a manual check can never stack two requests.
  bool _pollInFlight = false;

  /// The app is backgrounded ([onAppPaused]) — no generation polls are scheduled until
  /// [onAppResumed].
  bool _appPaused = false;

  /// Whether the countdown has already fired its one automatic submission for the current
  /// in-progress session. Reaching `00:00` hands the exam in once; what happens if that fails is
  /// decided by the failure (terminal, or a capped retry), never by the next countdown tick.
  bool _autoSubmitFired = false;

  /// Automatic submit retries already scheduled for the current in-progress session.
  int _submitRetries = 0;

  bool _disposed = false;

  void _emit(ExamState next) {
    // A request that was in flight when the screen closed must not touch a disposed notifier (or
    // schedule follow-up work for a screen nobody is looking at).
    if (_disposed) return;
    _state = next;
    notifyListeners();
  }

  void _syncSkew(DateTime serverTime) {
    _serverSkew = serverTime.difference(DateTime.now().toUtc());
  }

  /// The time left before [ExamInProgress.session.expiresAt], estimated against the
  /// server-synced clock. Zero once expired, and zero (never negative) outside
  /// [ExamInProgress] entirely.
  Duration remaining() {
    final current = _state;
    if (current is! ExamInProgress) return Duration.zero;
    final expiresAt = current.session.expiresAt;
    if (expiresAt == null) return Duration.zero;
    final estimatedServerNow = DateTime.now().toUtc().add(_serverSkew);
    final left = expiresAt.difference(estimatedServerNow);
    return left.isNegative ? Duration.zero : left;
  }

  /// Resumes whatever was left in play by a previous app run — the interruption-recovery entry
  /// point. Call once, right after construction. A no-op (lands on [ExamSetup]) if nothing was
  /// ever started, or if the last-known session is gone server-side.
  Future<void> restore() async {
    final draft = await _progressStore.load(_studentId);
    if (draft == null) {
      _emit(const ExamSetup());
      return;
    }

    try {
      final result = await _client.getExam(studentId: _studentId, examId: draft.examSessionId);
      await _applySession(result, draft: draft);
    } on DioException catch (error) {
      if (error.apiError?.code == 'AI_EXAM_NOT_FOUND') {
        await _progressStore.clear(_studentId);
        _emit(const ExamSetup());
        return;
      }
      // Any other failure (network, most likely) leaves the draft in place — the pointer to an
      // exam the student already committed quota to must not be discarded just because this one
      // resume attempt couldn't reach the server.
      _emit(const ExamSetup(restoreFailed: true));
    } catch (_) {
      _emit(const ExamSetup(restoreFailed: true));
    }
  }

  /// Creates a new exam session from [materialIds] and begins polling for generation to finish.
  /// No-op while already creating, with no materials selected, over the material cap, or with a
  /// [questionCount] / [durationMinutes] outside the server's accepted range.
  Future<void> create({
    required List<String> materialIds,
    int? questionCount,
    List<ExamItemType>? questionTypes,
    int? durationMinutes,
  }) async {
    final current = _state;
    if (current is! ExamSetup || current.isCreating) return;
    if (materialIds.isEmpty || materialIds.length > examMaxMaterials) return;
    if (questionCount != null &&
        (questionCount < examMinQuestions || questionCount > examMaxQuestions)) {
      return;
    }
    if (durationMinutes != null &&
        (durationMinutes < examMinDurationMinutes || durationMinutes > examMaxDurationMinutes)) {
      return;
    }

    _emit(current.copyWith(isCreating: true, clearError: true));

    try {
      final result = await _client.createExam(
        studentId: _studentId,
        materialIds: materialIds,
        questionCount: questionCount,
        questionTypes: questionTypes,
        durationMinutes: durationMinutes,
      );
      await _progressStore.save(_studentId, ExamDraft(examSessionId: result.session.id));
      _syncSkew(result.serverTime);
      _emit(ExamGenerating(session: result.session));
      _startPolling();
    } on DioException catch (error) {
      _emit(ExamSetup(createError: _classifyCreateError(error)));
    } catch (_) {
      _emit(const ExamSetup(createError: ExamCreateError.unknown));
    }
  }

  /// Re-attempts [restore] after a failed one — the setup screen's action when
  /// [ExamSetup.restoreFailed] is set.
  Future<void> retryRestore() => restore();

  /// Begins a fresh polling window: backoff back at [examGenerationPollInitialInterval], the
  /// [examGenerationPollWindow] budget unspent.
  void _startPolling() {
    _pollDelay = examGenerationPollInitialInterval;
    _pollElapsed = Duration.zero;
    _scheduleNextPoll();
  }

  /// Schedules one generation poll after the current backoff delay — a one-shot timer re-armed
  /// after each response, never a periodic one, so a slow response can't overlap the next tick.
  /// Once the next poll would land past the window, flags [ExamGenerating.pollingStopped]
  /// instead.
  void _scheduleNextPoll() {
    _pollTimer?.cancel();
    final current = _state;
    if (_disposed || _appPaused || current is! ExamGenerating) return;

    final delay = _pollDelay;
    if (_pollElapsed + delay > examGenerationPollWindow) {
      if (!current.pollingStopped) {
        _emit(ExamGenerating(session: current.session, pollingStopped: true));
      }
      return;
    }

    _pollElapsed += delay;
    final doubled = delay * 2;
    _pollDelay = doubled > examGenerationPollMaxInterval ? examGenerationPollMaxInterval : doubled;
    _pollTimer = Timer(delay, () async {
      await checkGenerationProgress();
      _scheduleNextPoll();
    });
  }

  /// Polls the session once and advances past [ExamGenerating] if it's no longer generating.
  /// Public (not just timer-driven) so a pull-to-refresh or a test can trigger it directly.
  /// No-op unless the current state is actually [ExamGenerating], or while another check is
  /// already in flight. Doesn't itself re-arm polling — see [checkAgain] for the student's action.
  Future<void> checkGenerationProgress() async {
    final current = _state;
    if (current is! ExamGenerating) {
      _pollTimer?.cancel();
      return;
    }
    if (_pollInFlight) return;
    _pollInFlight = true;

    try {
      final result = await _client.getExam(studentId: _studentId, examId: current.session.id);
      // The student may have abandoned this exam (and even created another) while the request
      // was in flight — only fold the response into the session it was asked about.
      final latest = _state;
      if (latest is! ExamGenerating || latest.session.id != current.session.id) return;
      if (result.session.status == ExamSessionStatus.generating) {
        _emit(ExamGenerating(session: result.session, pollingStopped: latest.pollingStopped));
        return;
      }
      _pollTimer?.cancel();
      await _applySession(result);
    } catch (_) {
      // Transient network blip — the next scheduled poll (if any) tries again.
    } finally {
      _pollInFlight = false;
    }
  }

  /// The student's "check again" action once [ExamGenerating.pollingStopped] is showing: checks
  /// right away and, if the exam is still generating, opens a fresh polling window. No-op outside
  /// [ExamGenerating].
  Future<void> checkAgain() async {
    final current = _state;
    if (current is! ExamGenerating) return;
    _pollTimer?.cancel();
    if (current.pollingStopped) _emit(ExamGenerating(session: current.session));
    await checkGenerationProgress();
    _startPolling();
  }

  /// The app went to the background: stop generation polling (nobody is watching, and on Android
  /// timers keep firing for a while). The countdown keeps running — it's local, and an exam that
  /// times out in the background should still be handed in on time.
  void onAppPaused() {
    _appPaused = true;
    _pollTimer?.cancel();
  }

  /// The app is back in the foreground: a still-generating exam gets an immediate check and a
  /// fresh polling window, even if the previous window had already stopped.
  void onAppResumed() {
    if (!_appPaused) return;
    _appPaused = false;
    if (_state is ExamGenerating) unawaited(checkAgain());
  }

  /// Begins the server-enforced timer: `ready -> in_progress`, revealing every item. No-op
  /// unless the current state is [ExamReady] and no start is already in flight.
  Future<void> start() async {
    final current = _state;
    if (current is! ExamReady || current.isStarting) return;
    _emit(current.copyWith(isStarting: true, startFailed: false));

    try {
      final result = await _client.startExam(studentId: _studentId, examId: current.session.id);
      _syncSkew(result.serverTime);
      final draft = ExamDraft(examSessionId: current.session.id);
      await _progressStore.save(_studentId, draft);
      _emit(ExamInProgress(session: result.session));
      _beginCountdown();
    } catch (_) {
      _emit(current.copyWith(isStarting: false, startFailed: true));
    }
  }

  /// Starts the countdown for a freshly-entered in-progress session, resetting its one-shot
  /// auto-submit and retry budget.
  void _beginCountdown() {
    _countdownTimer?.cancel();
    _submitRetryTimer?.cancel();
    _autoSubmitFired = false;
    _submitRetries = 0;
    if (_disposed) return;
    _countdownTimer = Timer.periodic(examCountdownTickInterval, (_) => checkExpiry());
  }

  void _stopInProgressTimers() {
    _countdownTimer?.cancel();
    _submitRetryTimer?.cancel();
  }

  /// Notifies listeners so the countdown display re-renders and, once time is up, submits
  /// automatically with whatever was answered — the "submission" half of the tamper-resistant
  /// timer: the student is never left staring at `00:00` unable to hand in what they have.
  ///
  /// Fires that submission **once** per session and then stops ticking (nothing on screen changes
  /// past `00:00`). A failed auto-submit is handled by [submit]'s own failure path — terminal for a
  /// 4xx, a capped backoff for a network error or 5xx — never by re-submitting on every tick, which
  /// would hammer the server with a request per second for as long as the screen stayed open.
  /// No-op outside [ExamInProgress]; public so a test can drive expiry without waiting on the real
  /// timer.
  void checkExpiry() {
    final current = _state;
    if (current is! ExamInProgress) {
      _countdownTimer?.cancel();
      return;
    }
    if (_disposed) return;
    notifyListeners();
    if (remaining() > Duration.zero) return;

    _countdownTimer?.cancel();
    if (_autoSubmitFired) return;
    _autoSubmitFired = true;
    // A hand-in the student started by hand is already in flight; its own failure path covers it.
    if (!current.isSubmitting) unawaited(submit());
  }

  /// Records [value] as [itemId]'s answer in the local draft. Blank clears a previously-saved
  /// answer — the server treats a missing entry and an empty one identically (wrong), so there
  /// is no reason to keep an empty string around. No-op outside [ExamInProgress].
  Future<void> answer(String itemId, String value) async {
    final current = _state;
    if (current is! ExamInProgress) return;

    final trimmed = value.trim();
    final updated = {...current.answers};
    if (trimmed.isEmpty) {
      updated.remove(itemId);
    } else {
      updated[itemId] = trimmed;
    }
    _emit(current.copyWith(answers: updated));
    await _progressStore.save(
      _studentId,
      ExamDraft(
        examSessionId: current.session.id,
        answers: updated,
        currentIndex: current.currentIndex,
      ),
    );
  }

  /// Moves to the next item. No-op on the last item — the player screen calls [submit] instead
  /// once [ExamInProgress.isLastItem] is true.
  Future<void> next() async {
    final current = _state;
    if (current is! ExamInProgress || current.isLastItem) return;
    final index = current.currentIndex + 1;
    _emit(current.copyWith(currentIndex: index));
    await _progressStore.save(
      _studentId,
      ExamDraft(examSessionId: current.session.id, answers: current.answers, currentIndex: index),
    );
  }

  /// Moves to the previous item. No-op on the first item.
  Future<void> previous() async {
    final current = _state;
    if (current is! ExamInProgress || current.currentIndex == 0) return;
    final index = current.currentIndex - 1;
    _emit(current.copyWith(currentIndex: index));
    await _progressStore.save(
      _studentId,
      ExamDraft(examSessionId: current.session.id, answers: current.answers, currentIndex: index),
    );
  }

  /// Submits the current answer draft for deterministic scoring and a per-topic report. Callable
  /// any time during [ExamInProgress] (an early hand-in) as well as automatically once the
  /// countdown reaches zero. No-op if a submit is already in flight or the state isn't
  /// [ExamInProgress].
  ///
  /// How a failure lands:
  /// - 409 `AI_EXAM_EXPIRED` is terminal — [ExamExpired], countdown stopped, draft cleared.
  /// - 409 `AI_EXAM_INVALID_STATE` most likely means an earlier attempt did land but its response
  ///   was lost; the session is re-read so a hand-in that succeeded shows its report.
  /// - A network error or 5xx after the deadline is re-sent automatically with capped exponential
  ///   backoff ([examSubmitRetryInitialDelay] doubling to [examSubmitRetryMaxDelay], at most
  ///   [examSubmitMaxRetries] times) — nobody may be there to tap "submit" again. Before the
  ///   deadline the student is, so the error is just shown.
  /// - Anything else (another 4xx) is shown and never retried automatically.
  Future<void> submit() async {
    final current = _state;
    if (current is! ExamInProgress || current.isSubmitting) return;
    _submitRetryTimer?.cancel();
    _emit(current.copyWith(isSubmitting: true, clearSubmitError: true));

    try {
      final result = await _client.submitExam(
        studentId: _studentId,
        examId: current.session.id,
        answers: current.answers,
      );
      if (!_isStillInProgress(current)) return;
      _stopInProgressTimers();
      await _progressStore.clear(_studentId);
      _emit(ExamSubmitted(session: result.session));
    } on DioException catch (error) {
      if (!_isStillInProgress(current)) return;
      await _onSubmitFailed(current, error);
    } catch (_) {
      if (!_isStillInProgress(current)) return;
      _emit(current.copyWith(isSubmitting: false, submitError: ExamSubmitError.unknown));
    }
  }

  /// Whether the screen is still on [submitted]'s session — false once the student abandoned it
  /// ([startNewExam]) while a submit was in flight, whose late response must then be dropped.
  bool _isStillInProgress(ExamInProgress submitted) {
    final latest = _state;
    return latest is ExamInProgress && latest.session.id == submitted.session.id;
  }

  Future<void> _onSubmitFailed(ExamInProgress current, DioException error) async {
    switch (error.apiError?.code) {
      case 'AI_EXAM_EXPIRED':
        _stopInProgressTimers();
        await _progressStore.clear(_studentId);
        _emit(ExamExpired(session: current.session));
        return;
      case 'AI_EXAM_INVALID_STATE':
        try {
          final result = await _client.getExam(studentId: _studentId, examId: current.session.id);
          if (!_isStillInProgress(current)) return;
          if (result.session.status != ExamSessionStatus.inProgress) {
            _stopInProgressTimers();
            await _applySession(result);
            return;
          }
        } catch (_) {
          // Couldn't re-read it either — fall through and show the error.
        }
    }

    if (_isRetryableSubmitFailure(error) &&
        remaining() == Duration.zero &&
        _submitRetries < examSubmitMaxRetries &&
        !_disposed) {
      final scaled = examSubmitRetryInitialDelay * (1 << _submitRetries);
      final delay = scaled > examSubmitRetryMaxDelay ? examSubmitRetryMaxDelay : scaled;
      _submitRetries++;
      _submitRetryTimer?.cancel();
      _submitRetryTimer = Timer(delay, () => unawaited(submit()));
    }
    _emit(current.copyWith(isSubmitting: false, submitError: _classifySubmitError(error)));
  }

  /// Worth re-sending unchanged: no response at all, or a server-side (5xx) failure. A 4xx is the
  /// server's answer about this request and will be the same answer next time.
  bool _isRetryableSubmitFailure(DioException error) {
    final status = error.response?.statusCode ?? error.apiError?.status;
    if (status != null) return status >= 500;
    return switch (error.type) {
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout ||
      DioExceptionType.connectionError => true,
      _ => false,
    };
  }

  /// Discards whatever exam is saved locally and returns to setup. Safe to call from any state —
  /// abandoning an exam mid-session is a normal exit, not an error; the session row and its spent
  /// quota already exist server-side regardless of whether it's finished.
  Future<void> startNewExam() async {
    _pollTimer?.cancel();
    _stopInProgressTimers();
    await _progressStore.clear(_studentId);
    _emit(const ExamSetup());
  }

  @override
  void dispose() {
    _disposed = true;
    _pollTimer?.cancel();
    _stopInProgressTimers();
    super.dispose();
  }

  /// Folds a freshly-fetched [ExamClientResult] into the right [ExamState] for its
  /// [ExamSession.status], reconciling [draft]'s local answers on top when resuming an
  /// [ExamSessionStatus.inProgress] session. Starts whichever background timer that state needs.
  Future<void> _applySession(ExamClientResult result, {ExamDraft? draft}) async {
    _syncSkew(result.serverTime);
    final session = result.session;

    switch (session.status) {
      case ExamSessionStatus.generating:
        _emit(ExamGenerating(session: session));
        _startPolling();
      case ExamSessionStatus.ready:
        _emit(ExamReady(session: session));
      case ExamSessionStatus.inProgress:
        final items = session.items ?? const <ExamItem>[];
        final itemIds = {for (final item in items) item.id};
        final answers = <String, String>{
          for (final entry in draft?.answers.entries ?? const <MapEntry<String, String>>[])
            if (itemIds.contains(entry.key)) entry.key: entry.value,
        };
        final maxIndex = items.isEmpty ? 0 : items.length - 1;
        final rawIndex = draft?.currentIndex ?? 0;
        final currentIndex = rawIndex < 0 ? 0 : (rawIndex > maxIndex ? maxIndex : rawIndex);
        _emit(ExamInProgress(session: session, answers: answers, currentIndex: currentIndex));
        _beginCountdown();
        checkExpiry();
      case ExamSessionStatus.submitted:
        await _progressStore.clear(_studentId);
        _emit(ExamSubmitted(session: session));
      case ExamSessionStatus.failed:
        await _progressStore.clear(_studentId);
        _emit(ExamFailed(session: session));
    }
  }

  ExamCreateError _classifyCreateError(DioException error) {
    final apiError = error.apiError;
    if (apiError != null) {
      return switch (apiError.code) {
        'AI_QUOTA_EXCEEDED' => ExamCreateError.quotaExceeded,
        'AI_SUBSCRIPTION_INACTIVE' => ExamCreateError.subscriptionInactive,
        'FEATURE_NOT_INCLUDED' || 'FEATURE_EXPIRED' => ExamCreateError.subscriptionInactive,
        'FEATURE_LIMIT_REACHED' => ExamCreateError.featureLimitReached,
        'AI_SCHOOL_INACTIVE' => ExamCreateError.schoolInactive,
        'AI_LLM_DISABLED' => ExamCreateError.llmDisabled,
        'RESOURCE_NOT_FOUND' => ExamCreateError.materialNotFound,
        'VALIDATION_FAILED' => ExamCreateError.materialNotReady,
        'AI_EXAM_GENERATION_UNAVAILABLE' => ExamCreateError.generationUnavailable,
        _ => ExamCreateError.unknown,
      };
    }
    return switch (error.type) {
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout ||
      DioExceptionType.connectionError => ExamCreateError.network,
      _ => ExamCreateError.unknown,
    };
  }

  ExamSubmitError _classifySubmitError(DioException error) {
    if (error.apiError?.code == 'AI_EXAM_EXPIRED') return ExamSubmitError.expired;
    return switch (error.type) {
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout ||
      DioExceptionType.connectionError => ExamSubmitError.network,
      _ => ExamSubmitError.unknown,
    };
  }
}
