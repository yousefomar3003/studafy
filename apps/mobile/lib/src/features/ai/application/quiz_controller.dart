import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../../core/api/api_exception.dart';
import '../data/quiz_client.dart';
import '../data/quiz_progress_store.dart';
import '../domain/quiz.dart';
import '../domain/quiz_attempt.dart';
import '../domain/quiz_state.dart';

/// Mirrors `AI_QUIZ_MIN_QUESTIONS` / `AI_QUIZ_MAX_QUESTIONS` / `AI_QUIZ_DEFAULT_QUESTIONS`
/// (`apps/api/src/modules/ai/config.ts`) so the setup step can't ask for a count the server would
/// reject, and `AI_QUIZ_MAX_MATERIALS` so the material picker caps selection at what one request
/// accepts.
const int quizMinQuestions = 1;
const int quizMaxQuestions = 15;
const int quizDefaultQuestions = 5;
const int quizMaxMaterials = 5;

/// Drives one quiz session: generation, one round of question-by-question play with instant
/// per-question feedback, and retry-wrong-only rounds — folding `QuizClient`'s responses into the
/// [QuizState] the screen renders, and writing every step to [QuizProgressStore] so the session
/// survives an app restart or a lost connection.
///
/// A plain [ChangeNotifier], not a Riverpod provider — same call as `AskAiController` and
/// `SubmissionFormController`: this state belongs to exactly one screen for the life of one quiz
/// and is read nowhere else. Created in the screen's `State` and disposed with it.
class QuizController extends ChangeNotifier {
  QuizController({
    required QuizClient client,
    required QuizProgressStore progressStore,
    required String studentId,
  }) : _client = client,
       _progressStore = progressStore,
       _studentId = studentId;

  final QuizClient _client;
  final QuizProgressStore _progressStore;
  final String _studentId;

  QuizState _state = const QuizSetup();
  QuizState get state => _state;

  void _emit(QuizState next) {
    _state = next;
    notifyListeners();
  }

  Future<void> _persist(GeneratedQuiz quiz, QuizAttempt attempt) {
    return _progressStore.save(_studentId, QuizSession(quiz: quiz, attempt: attempt));
  }

  /// Loads a session left in progress (or just finished) by a previous app run. Call once, right
  /// after construction — a no-op if nothing was ever saved, or if the last save was already
  /// cleared by [startNewQuiz].
  Future<void> restore() async {
    final session = await _progressStore.load(_studentId);
    if (session == null) return;
    _emit(
      session.attempt.isFinished
          ? QuizRoundResults(quiz: session.quiz, attempt: session.attempt)
          : QuizInProgress(quiz: session.quiz, attempt: session.attempt),
    );
  }

  /// Generates a quiz from [materialIds] and starts round 1. No-op while already generating, with
  /// no materials selected, over the material cap, or with a [questionCount] outside the
  /// server's accepted range — the setup screen shouldn't be able to trigger those, but this
  /// stays defensive the same way `AskAiController.send` guards question length before the round
  /// trip.
  Future<void> generate({
    required List<String> materialIds,
    int? questionCount,
    List<QuizQuestionType>? questionTypes,
  }) async {
    final current = _state;
    if (current is! QuizSetup || current.isGenerating) return;
    if (materialIds.isEmpty || materialIds.length > quizMaxMaterials) return;
    if (questionCount != null &&
        (questionCount < quizMinQuestions || questionCount > quizMaxQuestions)) {
      return;
    }

    _emit(current.copyWith(isGenerating: true, clearError: true));

    try {
      final quiz = await _client.generateQuiz(
        studentId: _studentId,
        materialIds: materialIds,
        questionCount: questionCount,
        questionTypes: questionTypes,
      );
      final attempt = QuizAttempt(
        quizId: quiz.quizId,
        questionIds: [for (final question in quiz.questions) question.id],
      );
      _emit(QuizInProgress(quiz: quiz, attempt: attempt));
      await _persist(quiz, attempt);
    } on DioException catch (error) {
      _emit(QuizSetup(generateError: _classifyGenerateError(error)));
    } catch (_) {
      _emit(const QuizSetup(generateError: QuizGenerateError.unknown));
    }
  }

  /// Records [answer] for the current question and grades it immediately — the round trip that
  /// gets the player its "instant feedback". No-op if there's no round in progress, a grade call
  /// for a previous answer is still in flight, or [answer] is blank.
  Future<void> submitAnswer(String answer) async {
    final current = _state;
    if (current is! QuizInProgress || current.isGrading) return;
    final trimmed = answer.trim();
    if (trimmed.isEmpty) return;

    final questionId = current.attempt.currentQuestionId;
    var attempt = current.attempt.copyWith(
      answers: {...current.attempt.answers, questionId: trimmed},
    );
    _emit(QuizInProgress(quiz: current.quiz, attempt: attempt, isGrading: true));
    await _persist(current.quiz, attempt);

    try {
      final results = await _client.gradeQuiz(
        studentId: _studentId,
        quizId: attempt.quizId,
        answers: attempt.answers,
      );
      attempt = attempt.copyWith(results: _mergeResults(attempt, results, revealAll: false));
      _emit(QuizInProgress(quiz: current.quiz, attempt: attempt));
      await _persist(current.quiz, attempt);
    } catch (_) {
      _emit(QuizInProgress(quiz: current.quiz, attempt: attempt, gradeFailed: true));
    }
  }

  /// Re-attempts the grade call [submitAnswer] made when it failed. No-op unless the current
  /// state actually has a failed grade to retry.
  Future<void> retryGrade() async {
    final current = _state;
    if (current is! QuizInProgress || !current.gradeFailed) return;
    _emit(current.copyWith(isGrading: true, gradeFailed: false));

    try {
      final results = await _client.gradeQuiz(
        studentId: _studentId,
        quizId: current.attempt.quizId,
        answers: current.attempt.answers,
      );
      final attempt = current.attempt.copyWith(
        results: _mergeResults(current.attempt, results, revealAll: false),
      );
      _emit(QuizInProgress(quiz: current.quiz, attempt: attempt));
      await _persist(current.quiz, attempt);
    } catch (_) {
      _emit(current.copyWith(isGrading: false, gradeFailed: true));
    }
  }

  /// Advances to the next question, or — from the last question, once it's graded — ends the
  /// round and shows results. No-op if the current question hasn't been graded yet.
  void next() {
    final current = _state;
    if (current is! QuizInProgress) return;
    final attempt = current.attempt;
    if (!attempt.results.containsKey(attempt.currentQuestionId)) return;

    if (attempt.isLastQuestion) {
      _emit(QuizRoundResults(quiz: current.quiz, attempt: attempt));
      unawaited(_persist(current.quiz, attempt));
      return;
    }

    final advanced = attempt.copyWith(currentIndex: attempt.currentIndex + 1);
    _emit(QuizInProgress(quiz: current.quiz, attempt: advanced));
    unawaited(_persist(current.quiz, advanced));
  }

  /// Ends the round now, grading whatever was answered so far — the rest are scored wrong and
  /// their answer key revealed, same as `quiz/grading.ts` treats any unanswered question. This is
  /// the one grade call this controller makes with `revealAll: true`: only once the round is
  /// deliberately over is it safe to show results for a question the student never reached.
  Future<void> endRoundNow() async {
    final current = _state;
    if (current is! QuizInProgress || current.isGrading) return;
    _emit(current.copyWith(isGrading: true, gradeFailed: false));

    try {
      final results = await _client.gradeQuiz(
        studentId: _studentId,
        quizId: current.attempt.quizId,
        answers: current.attempt.answers,
      );
      final attempt = current.attempt.copyWith(
        results: _mergeResults(current.attempt, results, revealAll: true),
      );
      _emit(QuizRoundResults(quiz: current.quiz, attempt: attempt));
      await _persist(current.quiz, attempt);
    } catch (_) {
      _emit(current.copyWith(isGrading: false, gradeFailed: true));
    }
  }

  /// Starts a new round covering only [QuizAttempt.wrongQuestionIds] from the round just
  /// finished. No-op if nothing was wrong (nothing to retry) or the round isn't actually over.
  Future<void> retryWrongOnly() async {
    final current = _state;
    if (current is! QuizRoundResults) return;
    final wrongIds = current.attempt.wrongQuestionIds;
    if (wrongIds.isEmpty) return;

    final attempt = QuizAttempt(
      quizId: current.quiz.quizId,
      questionIds: wrongIds,
      round: current.attempt.round + 1,
    );
    _emit(QuizInProgress(quiz: current.quiz, attempt: attempt));
    await _persist(current.quiz, attempt);
  }

  /// Discards whatever session is saved and returns to setup. Safe to call from any state —
  /// abandoning a quiz mid-round is a normal exit, not an error, and nothing server-side needs
  /// cleaning up (the quiz row already exists from generation regardless of whether it's played
  /// to completion, and grading is a stateless read).
  Future<void> startNewQuiz() async {
    await _progressStore.clear(_studentId);
    _emit(const QuizSetup());
  }

  /// Keeps a server result only when it belongs to this round ([QuizAttempt.questionIds] — the
  /// grade endpoint returns every question in the whole quiz, not just this round's subset) and,
  /// unless [revealAll], only when the student actually submitted an answer for it — otherwise a
  /// grade call triggered by question 2 would hand back question 5's answer key before the
  /// student ever reaches it.
  Map<String, QuizQuestionResult> _mergeResults(
    QuizAttempt attempt,
    List<QuizQuestionResult> serverResults, {
    required bool revealAll,
  }) {
    final merged = {...attempt.results};
    for (final result in serverResults) {
      if (!attempt.questionIds.contains(result.questionId)) continue;
      if (!revealAll && !attempt.answers.containsKey(result.questionId)) continue;
      merged[result.questionId] = result;
    }
    return merged;
  }

  QuizGenerateError _classifyGenerateError(DioException error) {
    final apiError = error.apiError;
    if (apiError != null) {
      return switch (apiError.code) {
        'AI_QUOTA_EXCEEDED' => QuizGenerateError.quotaExceeded,
        'AI_SUBSCRIPTION_INACTIVE' => QuizGenerateError.subscriptionInactive,
        'AI_SCHOOL_INACTIVE' => QuizGenerateError.schoolInactive,
        'AI_LLM_DISABLED' => QuizGenerateError.llmDisabled,
        'RESOURCE_NOT_FOUND' => QuizGenerateError.materialNotFound,
        'VALIDATION_FAILED' => QuizGenerateError.materialNotReady,
        'AI_QUIZ_GENERATION_FAILED' ||
        'AI_LLM_UNAVAILABLE' ||
        'AI_LLM_REQUEST_REJECTED' => QuizGenerateError.generationFailed,
        _ => QuizGenerateError.unknown,
      };
    }
    return switch (error.type) {
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout ||
      DioExceptionType.connectionError => QuizGenerateError.network,
      _ => QuizGenerateError.unknown,
    };
  }
}
