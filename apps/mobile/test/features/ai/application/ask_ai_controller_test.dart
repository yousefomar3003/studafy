import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_controller.dart';
import 'package:studafy_mobile/src/features/ai/data/ask_ai_client.dart';
import 'package:studafy_mobile/src/features/ai/data/ask_ai_events.dart';
import 'package:studafy_mobile/src/features/ai/domain/ask_ai_conversation.dart';

/// Hand-written fake — same rationale as `_FakeSubmissionsClient`
/// (`submission_form_controller_test.dart`): [AskAiClient] is a thin wrapper over Dio, and a
/// mocking library would only add ceremony. Its one field is private, so `implements` needs
/// nothing but the two methods.
class _FakeAskAiClient implements AskAiClient {
  _FakeAskAiClient(this._events);

  /// Produces the event stream for one `ask` call. Throwing from here simulates a pre-stream
  /// problem response; returning a stream that emits an error simulates the same via the
  /// listener's `onError`.
  final Stream<AskAiEvent> Function() _events;

  final List<String?> conversationIdsSeen = [];
  int askCalls = 0;

  AskAiReportOutcome reportOutcome = AskAiReportOutcome.filed;
  int reportCalls = 0;

  @override
  Stream<AskAiEvent> ask({
    required String studentId,
    required String question,
    String? conversationId,
    String level = 'high',
  }) {
    askCalls++;
    conversationIdsSeen.add(conversationId);
    return _events();
  }

  @override
  Future<AskAiReportOutcome> report({
    required String studentId,
    required String messageId,
    required String reason,
  }) async {
    reportCalls++;
    return reportOutcome;
  }
}

AskAiController _controllerFor(_FakeAskAiClient client) =>
    AskAiController(client: client, studentId: 'student-1');

void main() {
  group('AskAiController.send', () {
    test('folds sources + deltas + done into one completed turn', () async {
      final client = _FakeAskAiClient(
        () => Stream.fromIterable([
          const AskAiSourcesEvent(conversationId: 'conv-1', sources: []),
          const AskAiDeltaEvent('Photo'),
          const AskAiDeltaEvent('synthesis'),
          const AskAiDoneEvent(
            messageId: 'msg-1',
            text: 'Photosynthesis converts light. [1]',
            citations: [
              AskAiCitation(
                order: 1,
                chunkId: 'chunk-1',
                materialId: 'material-1',
                materialTitle: 'Biology Unit 3',
                pageNumber: 12,
              ),
            ],
          ),
        ]),
      );
      final controller = _controllerFor(client);

      await controller.send('How does photosynthesis work?');

      expect(controller.state.turns, hasLength(1));
      expect(controller.state.turns.single.question, 'How does photosynthesis work?');
      expect(controller.state.conversationId, 'conv-1');
      expect(controller.state.isStreaming, isFalse);

      final answer = controller.state.turns.single.answer;
      expect(answer, isA<AskAiAnswerComplete>());
      answer as AskAiAnswerComplete;
      expect(answer.messageId, 'msg-1');
      expect(answer.text, 'Photosynthesis converts light. [1]');
      expect(answer.citations.single.pageNumber, 12);
    });

    test('exposes the running text token by token while streaming', () async {
      final events = StreamController<AskAiEvent>();
      final client = _FakeAskAiClient(() => events.stream);
      final controller = _controllerFor(client);

      final pending = controller.send('question');
      await Future<void>.value();

      events.add(const AskAiDeltaEvent('Hel'));
      await Future<void>.value();
      expect((controller.state.turns.single.answer as AskAiAnswerStreaming).text, 'Hel');
      expect(controller.state.isStreaming, isTrue);

      events.add(const AskAiDeltaEvent('lo'));
      await Future<void>.value();
      expect((controller.state.turns.single.answer as AskAiAnswerStreaming).text, 'Hello');

      events.add(const AskAiDoneEvent(messageId: 'm', text: 'Hello.', citations: []));
      await events.close();
      await pending;

      expect(controller.state.turns.single.answer, isA<AskAiAnswerComplete>());
    });

    test('renders a grounding refusal with its nearest topics', () async {
      final client = _FakeAskAiClient(
        () => Stream.fromIterable([
          const AskAiRefusalEvent([
            AskAiNearestTopic(chunkId: 'c1', materialTitle: 'Algebra Basics'),
          ]),
        ]),
      );
      final controller = _controllerFor(client);

      await controller.send('Explain the Riemann hypothesis');

      final answer = controller.state.turns.single.answer;
      expect(answer, isA<AskAiAnswerRefused>());
      expect((answer as AskAiAnswerRefused).nearestTopics.single.materialTitle, 'Algebra Basics');
      expect(controller.state.isStreaming, isFalse);
    });

    test('a rejected-request stream error is a non-retryable failure', () async {
      final client = _FakeAskAiClient(
        () => Stream.fromIterable([
          const AskAiStreamErrorEvent(code: 'AI_LLM_REQUEST_REJECTED', message: 'no'),
        ]),
      );
      final controller = _controllerFor(client);

      await controller.send('question');

      final answer = controller.state.turns.single.answer as AskAiAnswerFailed;
      expect(answer.isRetryable, isFalse);
    });

    test('output moderation block replaces any partial answer', () async {
      final client = _FakeAskAiClient(
        () => Stream.fromIterable([
          const AskAiDeltaEvent('partial unsafe text'),
          const AskAiModerationBlockedEvent('Try rephrasing your question.'),
        ]),
      );
      final controller = _controllerFor(client);

      await controller.send('question');

      final answer = controller.state.turns.single.answer;
      expect(answer, isA<AskAiAnswerBlocked>());
      expect((answer as AskAiAnswerBlocked).guidance, 'Try rephrasing your question.');
    });

    test('a pre-stream quota error drops the turn and raises a banner', () async {
      final client = _FakeAskAiClient(
        () => Stream<AskAiEvent>.error(
          const ApiException(status: 429, title: 'quota', code: 'AI_QUOTA_EXCEEDED'),
        ),
      );
      final controller = _controllerFor(client);

      await controller.send('question');

      expect(controller.state.turns, isEmpty);
      expect(controller.state.sendError, AskAiSendError.quotaExceeded);
      expect(controller.state.isStreaming, isFalse);
      expect(controller.retryableQuestion, isNull);
    });

    test('a connectivity failure keeps the question for retry', () async {
      final client = _FakeAskAiClient(
        () => Stream<AskAiEvent>.error(
          DioException(
            requestOptions: RequestOptions(path: '/ask'),
            type: DioExceptionType.connectionError,
          ),
        ),
      );
      final controller = _controllerFor(client);

      await controller.send('a lasting question');

      expect(controller.state.sendError, AskAiSendError.network);
      expect(controller.retryableQuestion, 'a lasting question');
    });

    test('threads the conversation id onto follow-up questions', () async {
      var call = 0;
      final client = _FakeAskAiClient(() {
        call++;
        return Stream.fromIterable([
          AskAiSourcesEvent(conversationId: 'conv-$call', sources: const []),
          AskAiDoneEvent(messageId: 'm-$call', text: 'answer $call', citations: const []),
        ]);
      });
      final controller = _controllerFor(client);

      await controller.send('first');
      await controller.send('second');

      expect(client.conversationIdsSeen, [null, 'conv-1']);
    });

    test('ignores a blank or over-long question', () async {
      final client = _FakeAskAiClient(() => const Stream.empty());
      final controller = _controllerFor(client);

      await controller.send('   ');
      await controller.send('x' * (askAiQuestionMaxChars + 1));

      expect(client.askCalls, 0);
      expect(controller.state.turns, isEmpty);
    });
  });

  test('reportAnswer forwards the outcome from the client', () async {
    final client = _FakeAskAiClient(() => const Stream.empty())
      ..reportOutcome = AskAiReportOutcome.alreadyFiled;
    final controller = _controllerFor(client);

    final outcome = await controller.reportAnswer(messageId: 'msg-1', reason: 'wrong');

    expect(outcome, AskAiReportOutcome.alreadyFiled);
    expect(client.reportCalls, 1);
  });
}
