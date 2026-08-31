import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../../core/api/api_exception.dart';
import '../data/ask_ai_client.dart';
import '../data/ask_ai_events.dart';
import '../domain/ask_ai_conversation.dart';

/// The endpoint's hard cap on question length (`AI_ASK_QUESTION_MAX_CHARS`). Mirrored here so the
/// composer can stop an over-long question before the round trip.
const int askAiQuestionMaxChars = 2000;

/// Drives one Ask AI conversation: sends a question, folds the answer's SSE events into the
/// [AskAiConversation] snapshot the screen renders, and files report actions.
///
/// A plain [ChangeNotifier], not a Riverpod provider — same call as [SubmissionFormController]:
/// this state belongs to exactly one screen for the life of one chat and is read nowhere else.
/// Created in the screen's `State` with the client and student id resolved from providers, and
/// disposed with it (which cancels an in-flight stream).
class AskAiController extends ChangeNotifier {
  // Private fields kept off the public constructor signature (callers pass `client:` etc.),
  // same as `SubmissionFormController`.
  AskAiController({required AskAiClient client, required String studentId, String level = 'high'})
    : _client = client, // ignore: prefer_initializing_formals
      _studentId = studentId, // ignore: prefer_initializing_formals
      _level = level; // ignore: prefer_initializing_formals

  final AskAiClient _client;
  final String _studentId;
  final String _level;

  AskAiConversation _state = const AskAiConversation();
  AskAiConversation get state => _state;

  StreamSubscription<AskAiEvent>? _subscription;

  /// The last question that failed before streaming — what a "retry" on the send-error banner
  /// re-sends.
  String? _retryableQuestion;
  String? get retryableQuestion => _retryableQuestion;

  void _emit(AskAiConversation next) {
    _state = next;
    notifyListeners();
  }

  /// Replaces the answer of the last turn (the one currently streaming).
  void _updateLastAnswer(AskAiAnswer answer) {
    final turns = _state.turns;
    if (turns.isEmpty) return;
    _emit(
      _state.copyWith(
        turns: [...turns.sublist(0, turns.length - 1), turns.last.copyWith(answer: answer)],
      ),
    );
  }

  /// Sends [question]. No-op while a stream is in flight or when [question] is blank / too long.
  Future<void> send(String question) async {
    final trimmed = question.trim();
    if (_state.isStreaming || trimmed.isEmpty || trimmed.length > askAiQuestionMaxChars) {
      return;
    }

    _retryableQuestion = null;
    _emit(
      _state.copyWith(
        turns: [
          ..._state.turns,
          AskAiTurn(question: trimmed, answer: const AskAiAnswerStreaming('')),
        ],
        isStreaming: true,
        clearSendError: true,
      ),
    );

    final completer = Completer<void>();
    _subscription =
        _client
            .ask(
              studentId: _studentId,
              question: trimmed,
              conversationId: _state.conversationId,
              level: _level,
            )
            .listen(
              _onEvent,
              onError: (Object error, StackTrace stackTrace) {
                _onSendError(trimmed, error);
                if (!completer.isCompleted) completer.complete();
              },
              onDone: () {
                _finishStream();
                if (!completer.isCompleted) completer.complete();
              },
              cancelOnError: true,
            );

    return completer.future;
  }

  /// Re-sends the question from the most recent pre-stream failure.
  Future<void> retryLastFailed() async {
    final question = _retryableQuestion;
    if (question == null) return;
    await send(question);
  }

  void _onEvent(AskAiEvent event) {
    switch (event) {
      case AskAiSourcesEvent(:final conversationId):
        _emit(_state.copyWith(conversationId: conversationId));
      case AskAiDeltaEvent(:final delta):
        // The contract puts every delta before any terminal event; ignore a stray one after so
        // it can't clobber a finished answer.
        final current = _state.turns.last.answer;
        if (current is AskAiAnswerStreaming) {
          _updateLastAnswer(AskAiAnswerStreaming(current.text + delta));
        }
      case AskAiDoneEvent(:final messageId, :final text, :final citations):
        _updateLastAnswer(
          AskAiAnswerComplete(messageId: messageId, text: text, citations: citations),
        );
      case AskAiRefusalEvent(:final topics):
        _updateLastAnswer(AskAiAnswerRefused(topics));
      case AskAiModerationBlockedEvent(:final guidance):
        _updateLastAnswer(AskAiAnswerBlocked(guidance));
      case AskAiStreamErrorEvent(:final code):
        _updateLastAnswer(AskAiAnswerFailed(_normalizeCode(code)));
    }
  }

  /// A failure *before* the stream opened: drop the optimistic turn (there is no answer to
  /// show) and surface the reason as a banner.
  void _onSendError(String question, Object error) {
    final classified = _classify(error);
    final turns = _state.turns;
    _emit(
      _state.copyWith(
        turns: turns.isEmpty ? turns : turns.sublist(0, turns.length - 1),
        isStreaming: false,
        sendError: classified,
        inputBlockedGuidance: error is ApiException && classified == AskAiSendError.questionBlocked
            ? error.detail
            : null,
      ),
    );
    _retryableQuestion =
        classified == AskAiSendError.network || classified == AskAiSendError.temporarilyUnavailable
        ? question
        : null;
    _subscription = null;
  }

  void _finishStream() {
    // If the stream closed without a terminal event, the still-"streaming" answer would hang.
    final last = _state.turns.isNotEmpty ? _state.turns.last.answer : null;
    if (last is AskAiAnswerStreaming) {
      _updateLastAnswer(const AskAiAnswerFailed('aiLlmUnavailable'));
    }
    _emit(_state.copyWith(isStreaming: false));
    _subscription = null;
  }

  AskAiSendError _classify(Object error) {
    if (error is ApiException) {
      return switch (error.code) {
        'AI_QUOTA_EXCEEDED' => AskAiSendError.quotaExceeded,
        'AI_SUBSCRIPTION_INACTIVE' => AskAiSendError.subscriptionInactive,
        'AI_SCHOOL_INACTIVE' => AskAiSendError.schoolInactive,
        'AI_LLM_DISABLED' => AskAiSendError.llmDisabled,
        'AI_QUOTA_UNAVAILABLE' => AskAiSendError.temporarilyUnavailable,
        'AI_MODERATION_INPUT_BLOCKED' => AskAiSendError.questionBlocked,
        'AUTHZ_FORBIDDEN' => AskAiSendError.notAllowed,
        _ => error.status == 401 ? AskAiSendError.notAllowed : AskAiSendError.unknown,
      };
    }
    if (error is DioException) {
      return switch (error.type) {
        DioExceptionType.connectionTimeout ||
        DioExceptionType.sendTimeout ||
        DioExceptionType.receiveTimeout ||
        DioExceptionType.connectionError => AskAiSendError.network,
        _ => AskAiSendError.unknown,
      };
    }
    return AskAiSendError.unknown;
  }

  /// The SSE `error` frame carries the raw `AI_LLM_*` code; the domain layer speaks lowerCamel
  /// so the widget switch reads cleanly.
  String _normalizeCode(String wireCode) => switch (wireCode) {
    'AI_LLM_REQUEST_REJECTED' => 'aiLlmRequestRejected',
    _ => 'aiLlmUnavailable',
  };

  /// Files a report against a completed answer. Surfaces the outcome to the caller (the screen
  /// shows a snackbar); does not mutate conversation state.
  Future<AskAiReportOutcome> reportAnswer({
    required String messageId,
    required String reason,
  }) {
    return _client.report(studentId: _studentId, messageId: messageId, reason: reason);
  }

  /// Clears the send-error banner (e.g. the user dismissed it).
  void dismissSendError() {
    if (_state.sendError == null) return;
    _emit(_state.copyWith(clearSendError: true));
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }
}
