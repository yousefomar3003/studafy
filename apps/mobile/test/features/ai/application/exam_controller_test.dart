import 'dart:async';

import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/features/ai/application/exam_controller.dart';
import 'package:studafy_mobile/src/features/ai/data/exam_client.dart';
import 'package:studafy_mobile/src/features/ai/data/exam_progress_store.dart';
import 'package:studafy_mobile/src/features/ai/domain/exam.dart';
import 'package:studafy_mobile/src/features/ai/domain/exam_draft.dart';
import 'package:studafy_mobile/src/features/ai/domain/exam_session.dart';
import 'package:studafy_mobile/src/features/ai/domain/exam_state.dart';

/// Hand-written fake — same rationale as `_FakeFlashcardClient`
/// (`flashcard_controller_test.dart`): [ExamClient] is a thin wrapper over Dio, and a mocking
/// library would only add ceremony.
class _FakeExamClient implements ExamClient {
  Future<ExamClientResult> Function({
    required String studentId,
    required List<String> materialIds,
    int? questionCount,
    List<ExamItemType>? questionTypes,
    int? durationMinutes,
  })?
  createExamHandler;

  Future<ExamClientResult> Function({required String studentId, required String examId})?
  getExamHandler;

  Future<ExamClientResult> Function({required String studentId, required String examId})?
  startExamHandler;

  Future<ExamClientResult> Function({
    required String studentId,
    required String examId,
    required Map<String, String> answers,
  })?
  submitExamHandler;

  @override
  Future<ExamClientResult> createExam({
    required String studentId,
    required List<String> materialIds,
    int? questionCount,
    List<ExamItemType>? questionTypes,
    int? durationMinutes,
  }) => createExamHandler!(
    studentId: studentId,
    materialIds: materialIds,
    questionCount: questionCount,
    questionTypes: questionTypes,
    durationMinutes: durationMinutes,
  );

  @override
  Future<ExamClientResult> getExam({required String studentId, required String examId}) =>
      getExamHandler!(studentId: studentId, examId: examId);

  @override
  Future<ExamClientResult> startExam({required String studentId, required String examId}) =>
      startExamHandler!(studentId: studentId, examId: examId);

  @override
  Future<ExamClientResult> submitExam({
    required String studentId,
    required String examId,
    required Map<String, String> answers,
  }) => submitExamHandler!(studentId: studentId, examId: examId, answers: answers);
}

final _serverNow = DateTime.utc(2026, 1, 1, 12);

DioException _apiError(int status, String code) => DioException(
  requestOptions: RequestOptions(path: '/exams'),
  response: Response(
    requestOptions: RequestOptions(path: '/exams'),
    statusCode: status,
  ),
  error: ApiException(status: status, title: code, code: code),
);

DioException _networkError() => DioException(
  requestOptions: RequestOptions(path: '/exams'),
  type: DioExceptionType.connectionError,
);

ExamCitation _citation() =>
    const ExamCitation(chunkId: 'chunk-1', materialId: 'material-1', materialTitle: 'Bio');

ExamItem _mcqItem(String id, {int order = 1}) => ExamItem(
  id: id,
  order: order,
  type: ExamItemType.mcq,
  prompt: 'prompt $id',
  options: const [ExamOption(id: 'a', text: 'A'), ExamOption(id: 'b', text: 'B')],
  citation: _citation(),
);

ExamSession _generatingSession(String id) => ExamSession(
  id: id,
  status: ExamSessionStatus.generating,
  questionCount: 2,
  durationMinutes: 30,
  createdAt: _serverNow,
);

ExamSession _readySession(String id) => ExamSession(
  id: id,
  status: ExamSessionStatus.ready,
  questionCount: 2,
  durationMinutes: 30,
  createdAt: _serverNow,
);

ExamSession _inProgressSession(
  String id, {
  List<ExamItem>? items,
  DateTime? expiresAt,
}) => ExamSession(
  id: id,
  status: ExamSessionStatus.inProgress,
  questionCount: 2,
  durationMinutes: 30,
  createdAt: _serverNow,
  startedAt: _serverNow,
  expiresAt: expiresAt ?? _serverNow.add(const Duration(minutes: 30)),
  items: items ?? [_mcqItem('item-1'), _mcqItem('item-2', order: 2)],
);

ExamSession _submittedSession(String id) => ExamSession(
  id: id,
  status: ExamSessionStatus.submitted,
  questionCount: 2,
  durationMinutes: 30,
  createdAt: _serverNow,
  submittedAt: _serverNow,
  report: const ExamReport(correctCount: 1, totalItems: 2, percentage: 50, topics: []),
);

ExamSession _failedSession(String id) => ExamSession(
  id: id,
  status: ExamSessionStatus.failed,
  questionCount: 2,
  durationMinutes: 30,
  createdAt: _serverNow,
  failureReason: 'boom',
);

void main() {
  late OfflineDatabase database;
  late ExamProgressStore store;
  late _FakeExamClient client;
  late ExamController controller;

  setUp(() {
    database = OfflineDatabase(NativeDatabase.memory());
    store = ExamProgressStore(database);
    client = _FakeExamClient();
    controller = ExamController(client: client, progressStore: store, studentId: 'student-1');
  });

  tearDown(() async {
    controller.dispose();
    await database.close();
  });

  group('restore', () {
    test('starts on setup when nothing was ever created', () async {
      await controller.restore();
      expect(controller.state, isA<ExamSetup>());
    });

    test('resumes a still-generating session', () async {
      await store.save('student-1', const ExamDraft(examSessionId: 'exam-1'));
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _generatingSession(examId), serverTime: _serverNow);

      await controller.restore();

      expect(controller.state, isA<ExamGenerating>());
    });

    test('resumes a ready session', () async {
      await store.save('student-1', const ExamDraft(examSessionId: 'exam-1'));
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _readySession(examId), serverTime: _serverNow);

      await controller.restore();

      expect(controller.state, isA<ExamReady>());
    });

    test('resumes an in-progress session, replaying the local draft on top', () async {
      await store.save(
        'student-1',
        const ExamDraft(examSessionId: 'exam-1', answers: {'item-1': 'a'}, currentIndex: 1),
      );
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _inProgressSession(examId), serverTime: _serverNow);

      await controller.restore();

      final state = controller.state as ExamInProgress;
      expect(state.answers, {'item-1': 'a'});
      expect(state.currentIndex, 1);
    });

    test('drops draft answers naming an item outside the resumed session', () async {
      await store.save(
        'student-1',
        const ExamDraft(examSessionId: 'exam-1', answers: {'stale-item': 'x'}, currentIndex: 0),
      );
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _inProgressSession(examId), serverTime: _serverNow);

      await controller.restore();

      final state = controller.state as ExamInProgress;
      expect(state.answers, isEmpty);
    });

    test('resumes a submitted session and clears the draft', () async {
      await store.save('student-1', const ExamDraft(examSessionId: 'exam-1'));
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _submittedSession(examId), serverTime: _serverNow);

      await controller.restore();

      expect(controller.state, isA<ExamSubmitted>());
      expect(await store.load('student-1'), isNull);
    });

    test('resumes a failed session and clears the draft', () async {
      await store.save('student-1', const ExamDraft(examSessionId: 'exam-1'));
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _failedSession(examId), serverTime: _serverNow);

      await controller.restore();

      expect(controller.state, isA<ExamFailed>());
      expect(await store.load('student-1'), isNull);
    });

    test('clears the draft and lands on setup when the session is gone', () async {
      await store.save('student-1', const ExamDraft(examSessionId: 'exam-1'));
      client.getExamHandler = ({required studentId, required examId}) async {
        throw DioException(
          requestOptions: RequestOptions(path: '/exams'),
          response: Response(
            requestOptions: RequestOptions(path: '/exams'),
            statusCode: 404,
          ),
          error: const ApiException(status: 404, title: 'not found', code: 'AI_EXAM_NOT_FOUND'),
        );
      };

      await controller.restore();

      expect(controller.state, isA<ExamSetup>());
      expect(await store.load('student-1'), isNull);
    });

    test('keeps the draft and flags restoreFailed on a network error', () async {
      await store.save('student-1', const ExamDraft(examSessionId: 'exam-1'));
      client.getExamHandler = ({required studentId, required examId}) async {
        throw DioException(
          requestOptions: RequestOptions(path: '/exams'),
          type: DioExceptionType.connectionError,
        );
      };

      await controller.restore();

      final state = controller.state as ExamSetup;
      expect(state.restoreFailed, isTrue);
      expect(await store.load('student-1'), isNotNull);
    });
  });

  group('create', () {
    test('ignores an empty material selection', () async {
      var called = false;
      client.createExamHandler =
          ({
            required studentId,
            required materialIds,
            questionCount,
            questionTypes,
            durationMinutes,
          }) async {
            called = true;
            return ExamClientResult(session: _generatingSession('exam-1'), serverTime: _serverNow);
          };
      await controller.restore();

      await controller.create(materialIds: []);

      expect(called, isFalse);
      expect(controller.state, isA<ExamSetup>());
    });

    test('moves to generating and saves a draft on success', () async {
      client.createExamHandler =
          ({
            required studentId,
            required materialIds,
            questionCount,
            questionTypes,
            durationMinutes,
          }) async {
            return ExamClientResult(session: _generatingSession('exam-1'), serverTime: _serverNow);
          };
      await controller.restore();

      await controller.create(materialIds: ['material-1']);

      expect(controller.state, isA<ExamGenerating>());
      final draft = await store.load('student-1');
      expect(draft!.examSessionId, 'exam-1');
    });

    test('a quota-exceeded failure surfaces on setup', () async {
      client.createExamHandler =
          ({
            required studentId,
            required materialIds,
            questionCount,
            questionTypes,
            durationMinutes,
          }) async {
            throw DioException(
              requestOptions: RequestOptions(path: '/exams'),
              error: const ApiException(status: 429, title: 'quota', code: 'AI_QUOTA_EXCEEDED'),
            );
          };
      await controller.restore();

      await controller.create(materialIds: ['material-1']);

      final state = controller.state as ExamSetup;
      expect(state.createError, ExamCreateError.quotaExceeded);
      expect(state.isCreating, isFalse);
    });
  });

  group('checkGenerationProgress', () {
    test('stays generating while the server still reports generating', () async {
      client.createExamHandler =
          ({
            required studentId,
            required materialIds,
            questionCount,
            questionTypes,
            durationMinutes,
          }) async {
            return ExamClientResult(session: _generatingSession('exam-1'), serverTime: _serverNow);
          };
      await controller.restore();
      await controller.create(materialIds: ['material-1']);

      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _generatingSession(examId), serverTime: _serverNow);
      await controller.checkGenerationProgress();

      expect(controller.state, isA<ExamGenerating>());
    });

    test('advances to ready once the server reports ready', () async {
      client.createExamHandler =
          ({
            required studentId,
            required materialIds,
            questionCount,
            questionTypes,
            durationMinutes,
          }) async {
            return ExamClientResult(session: _generatingSession('exam-1'), serverTime: _serverNow);
          };
      await controller.restore();
      await controller.create(materialIds: ['material-1']);

      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _readySession(examId), serverTime: _serverNow);
      await controller.checkGenerationProgress();

      expect(controller.state, isA<ExamReady>());
    });
  });

  group('start', () {
    Future<void> reachReady() async {
      client.createExamHandler =
          ({
            required studentId,
            required materialIds,
            questionCount,
            questionTypes,
            durationMinutes,
          }) async {
            return ExamClientResult(session: _generatingSession('exam-1'), serverTime: _serverNow);
          };
      await controller.restore();
      await controller.create(materialIds: ['material-1']);
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _readySession(examId), serverTime: _serverNow);
      await controller.checkGenerationProgress();
    }

    test('reveals items and begins the timer on success', () async {
      await reachReady();
      client.startExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _inProgressSession(examId), serverTime: _serverNow);

      await controller.start();

      final state = controller.state as ExamInProgress;
      expect(state.items, hasLength(2));
      expect(state.currentIndex, 0);
    });

    test('a failure keeps the ready state with startFailed set', () async {
      await reachReady();
      client.startExamHandler = ({required studentId, required examId}) async {
        throw DioException(requestOptions: RequestOptions(path: '/start'));
      };

      await controller.start();

      final state = controller.state as ExamReady;
      expect(state.startFailed, isTrue);
    });
  });

  group('answer / next / previous', () {
    Future<void> reachInProgress() async {
      client.createExamHandler =
          ({
            required studentId,
            required materialIds,
            questionCount,
            questionTypes,
            durationMinutes,
          }) async {
            return ExamClientResult(session: _generatingSession('exam-1'), serverTime: _serverNow);
          };
      await controller.restore();
      await controller.create(materialIds: ['material-1']);
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _readySession(examId), serverTime: _serverNow);
      await controller.checkGenerationProgress();
      client.startExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _inProgressSession(examId), serverTime: _serverNow);
      await controller.start();
    }

    test('records an answer and persists it to the draft', () async {
      await reachInProgress();

      await controller.answer('item-1', 'a');

      final state = controller.state as ExamInProgress;
      expect(state.answers, {'item-1': 'a'});
      final draft = await store.load('student-1');
      expect(draft!.answers, {'item-1': 'a'});
    });

    test('blank clears a previously-saved answer', () async {
      await reachInProgress();
      await controller.answer('item-1', 'a');

      await controller.answer('item-1', '  ');

      final state = controller.state as ExamInProgress;
      expect(state.answers, isEmpty);
    });

    test('next/previous move within bounds', () async {
      await reachInProgress();

      await controller.next();
      expect((controller.state as ExamInProgress).currentIndex, 1);

      await controller.next();
      expect((controller.state as ExamInProgress).currentIndex, 1, reason: 'last item, no-op');

      await controller.previous();
      expect((controller.state as ExamInProgress).currentIndex, 0);

      await controller.previous();
      expect((controller.state as ExamInProgress).currentIndex, 0, reason: 'first item, no-op');
    });
  });

  group('submit', () {
    Future<void> reachInProgress({DateTime? expiresAt}) async {
      client.createExamHandler =
          ({
            required studentId,
            required materialIds,
            questionCount,
            questionTypes,
            durationMinutes,
          }) async {
            return ExamClientResult(session: _generatingSession('exam-1'), serverTime: _serverNow);
          };
      await controller.restore();
      await controller.create(materialIds: ['material-1']);
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _readySession(examId), serverTime: _serverNow);
      await controller.checkGenerationProgress();
      client.startExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(
            session: _inProgressSession(examId, expiresAt: expiresAt),
            serverTime: _serverNow,
          );
      await controller.start();
    }

    test('scores the exam and shows the report on success', () async {
      await reachInProgress();
      client.submitExamHandler = ({required studentId, required examId, required answers}) async =>
          ExamClientResult(session: _submittedSession(examId), serverTime: _serverNow);

      await controller.submit();

      expect(controller.state, isA<ExamSubmitted>());
      expect(await store.load('student-1'), isNull);
    });

    test('an expired submit is terminal: lands on expired and clears the draft', () async {
      await reachInProgress();
      await controller.answer('item-1', 'a');
      client.submitExamHandler = ({required studentId, required examId, required answers}) async {
        throw _apiError(409, 'AI_EXAM_EXPIRED');
      };

      await controller.submit();

      expect(controller.state, isA<ExamExpired>());
      expect(await store.load('student-1'), isNull);
    });

    test('an invalid-state submit re-reads the session and shows a report that did land', () async {
      await reachInProgress();
      client.submitExamHandler = ({required studentId, required examId, required answers}) async {
        throw _apiError(409, 'AI_EXAM_INVALID_STATE');
      };
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _submittedSession(examId), serverTime: _serverNow);

      await controller.submit();

      expect(controller.state, isA<ExamSubmitted>());
    });

    test('a network failure before the deadline is shown, not retried', () {
      fakeAsync((async) {
        reachInProgress();
        async.flushMicrotasks();
        var calls = 0;
        client.submitExamHandler = ({required studentId, required examId, required answers}) async {
          calls++;
          throw _networkError();
        };

        controller.submit();
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 2));

        expect(calls, 1);
        final state = controller.state as ExamInProgress;
        expect(state.submitError, ExamSubmitError.network);
        expect(state.isSubmitting, isFalse);
      });
    });

    test('checkExpiry auto-submits once the server-synced clock runs out', () async {
      await reachInProgress(expiresAt: _serverNow.subtract(const Duration(seconds: 1)));
      var submitted = false;
      client.submitExamHandler = ({required studentId, required examId, required answers}) async {
        submitted = true;
        return ExamClientResult(session: _submittedSession(examId), serverTime: _serverNow);
      };

      controller.checkExpiry();
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(submitted, isTrue);
      expect(controller.state, isA<ExamSubmitted>());
    });
  });

  group('auto-submit at the deadline', () {
    /// Lands on [ExamInProgress] for a session whose deadline already passed, via [restore] — the
    /// same path an app reopened after time ran out takes. [ExamController.restore] runs the first
    /// [ExamController.checkExpiry] itself, so the auto-submit has already fired on return.
    void resumePastDeadline(FakeAsync async) {
      store.save('student-1', const ExamDraft(examSessionId: 'exam-1', answers: {'item-1': 'a'}));
      async.flushMicrotasks();
      client.getExamHandler = ({required studentId, required examId}) async => ExamClientResult(
        session: _inProgressSession(
          examId,
          expiresAt: _serverNow.subtract(const Duration(seconds: 1)),
        ),
        serverTime: _serverNow,
      );
      controller.restore();
      async.flushMicrotasks();
    }

    test('an expired answer is terminal: one request, then no more ticks', () {
      fakeAsync((async) {
        var calls = 0;
        client.submitExamHandler = ({required studentId, required examId, required answers}) async {
          calls++;
          throw _apiError(409, 'AI_EXAM_EXPIRED');
        };

        resumePastDeadline(async);
        async.elapse(const Duration(minutes: 5));
        controller.checkExpiry();
        async.flushMicrotasks();

        expect(calls, 1);
        expect(controller.state, isA<ExamExpired>());
        expect(async.periodicTimerCount, 0, reason: 'countdown stopped');
        expect(async.nonPeriodicTimerCount, 0, reason: 'no retry scheduled');
      });
    });

    test('a non-expiry 4xx is shown and never retried', () {
      fakeAsync((async) {
        var calls = 0;
        client.submitExamHandler = ({required studentId, required examId, required answers}) async {
          calls++;
          throw _apiError(422, 'VALIDATION_FAILED');
        };

        resumePastDeadline(async);
        async.elapse(const Duration(minutes: 5));

        expect(calls, 1);
        final state = controller.state as ExamInProgress;
        expect(state.submitError, ExamSubmitError.unknown);
        expect(state.answers, {'item-1': 'a'}, reason: 'answers kept for a manual retry');
      });
    });

    test('network failures retry with capped exponential backoff, at most 5 times', () {
      fakeAsync((async) {
        final callTimes = <Duration>[];
        client.submitExamHandler = ({required studentId, required examId, required answers}) async {
          callTimes.add(async.elapsed);
          throw _networkError();
        };

        resumePastDeadline(async);
        async.elapse(const Duration(minutes: 10));

        // The auto-submit itself, then retries 2 s, 4 s, 8 s, 16 s, 30 s (capped) after each failure.
        expect(callTimes, const [
          Duration.zero,
          Duration(seconds: 2),
          Duration(seconds: 6),
          Duration(seconds: 14),
          Duration(seconds: 30),
          Duration(seconds: 60),
        ]);
        final state = controller.state as ExamInProgress;
        expect(state.submitError, ExamSubmitError.network);
        expect(state.isSubmitting, isFalse);
      });
    });

    test('a 5xx is retried and a later success shows the report', () {
      fakeAsync((async) {
        var calls = 0;
        client.submitExamHandler = ({required studentId, required examId, required answers}) async {
          calls++;
          if (calls == 1) throw _apiError(503, 'SERVICE_UNAVAILABLE');
          return ExamClientResult(session: _submittedSession(examId), serverTime: _serverNow);
        };

        resumePastDeadline(async);
        async.elapse(const Duration(seconds: 2));

        expect(calls, 2);
        expect(controller.state, isA<ExamSubmitted>());
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('dispose cancels a pending retry', () {
      fakeAsync((async) {
        var calls = 0;
        client.submitExamHandler = ({required studentId, required examId, required answers}) async {
          calls++;
          throw _networkError();
        };

        resumePastDeadline(async);
        controller.dispose();
        // tearDown disposes again; give it a fresh, never-used controller.
        controller = ExamController(client: client, progressStore: store, studentId: 'student-1');
        async.elapse(const Duration(minutes: 5));

        expect(calls, 1);
      });
    });
  });

  group('generation polling', () {
    void createGenerating(FakeAsync async) {
      client.createExamHandler =
          ({
            required studentId,
            required materialIds,
            questionCount,
            questionTypes,
            durationMinutes,
          }) async =>
              ExamClientResult(session: _generatingSession('exam-1'), serverTime: _serverNow);
      controller.restore();
      async.flushMicrotasks();
      controller.create(materialIds: ['material-1']);
      async.flushMicrotasks();
    }

    test('backs off 3 s -> 15 s and stops after the window with a check-again state', () {
      fakeAsync((async) {
        final pollTimes = <Duration>[];
        client.getExamHandler = ({required studentId, required examId}) async {
          pollTimes.add(async.elapsed);
          return ExamClientResult(session: _generatingSession(examId), serverTime: _serverNow);
        };

        createGenerating(async);
        async.elapse(const Duration(minutes: 30));

        expect(pollTimes.take(5), const [
          Duration(seconds: 3),
          Duration(seconds: 9),
          Duration(seconds: 21),
          Duration(seconds: 36),
          Duration(seconds: 51),
        ]);
        expect(pollTimes.last, lessThanOrEqualTo(examGenerationPollWindow));
        expect(pollTimes.length, lessThan(25));
        final state = controller.state as ExamGenerating;
        expect(state.pollingStopped, isTrue);
        expect(async.pendingTimers, isEmpty);

        // "Check again" polls right away and opens a fresh window.
        final before = pollTimes.length;
        controller.checkAgain();
        async.flushMicrotasks();
        expect(pollTimes.length, before + 1);
        expect((controller.state as ExamGenerating).pollingStopped, isFalse);
        async.elapse(const Duration(seconds: 3));
        expect(pollTimes.length, before + 2);
      });
    });

    test('never stacks a second request while one is in flight', () {
      fakeAsync((async) {
        var calls = 0;
        final pending = Completer<ExamClientResult>();
        client.getExamHandler = ({required studentId, required examId}) {
          calls++;
          return pending.future;
        };

        createGenerating(async);
        async.elapse(const Duration(seconds: 3));
        controller.checkGenerationProgress();
        controller.checkGenerationProgress();
        async.elapse(const Duration(minutes: 1));

        expect(calls, 1);
        pending.complete(
          ExamClientResult(session: _readySession('exam-1'), serverTime: _serverNow),
        );
        async.flushMicrotasks();
        expect(controller.state, isA<ExamReady>());
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('pauses while the app is backgrounded and checks right away on resume', () {
      fakeAsync((async) {
        var calls = 0;
        client.getExamHandler = ({required studentId, required examId}) async {
          calls++;
          return ExamClientResult(session: _generatingSession(examId), serverTime: _serverNow);
        };

        createGenerating(async);
        controller.onAppPaused();
        async.elapse(const Duration(minutes: 10));
        expect(calls, 0);

        controller.onAppResumed();
        async.flushMicrotasks();
        expect(calls, 1);
        async.elapse(const Duration(seconds: 3));
        expect(calls, 2);
      });
    });
  });

  group('startNewExam', () {
    test('clears the draft and returns to setup from any state', () async {
      await store.save('student-1', const ExamDraft(examSessionId: 'exam-1'));
      client.getExamHandler = ({required studentId, required examId}) async =>
          ExamClientResult(session: _generatingSession(examId), serverTime: _serverNow);
      await controller.restore();
      expect(controller.state, isA<ExamGenerating>());

      await controller.startNewExam();

      expect(controller.state, isA<ExamSetup>());
      expect(await store.load('student-1'), isNull);
    });
  });
}
