import 'package:dio/dio.dart';
import 'package:drift/native.dart';
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

    test('an expired submit surfaces the expired error without losing answers', () async {
      await reachInProgress();
      await controller.answer('item-1', 'a');
      client.submitExamHandler = ({required studentId, required examId, required answers}) async {
        throw DioException(
          requestOptions: RequestOptions(path: '/submit'),
          error: const ApiException(status: 409, title: 'expired', code: 'AI_EXAM_EXPIRED'),
        );
      };

      await controller.submit();

      final state = controller.state as ExamInProgress;
      expect(state.submitError, ExamSubmitError.expired);
      expect(state.answers, {'item-1': 'a'});
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
