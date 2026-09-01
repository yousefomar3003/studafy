import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/features/teacher/application/grade_entry_providers.dart';
import 'package:studafy_mobile/src/features/teacher/data/grade_entry_client.dart';
import 'package:studafy_mobile/src/features/teacher/domain/grade_entry.dart';

const _t0 = '2026-01-01T00:00:00.000Z';
const _t1 = '2026-01-02T00:00:00.000Z';

GradeCell _cell(String id, {num? score, num maxScore = 100, String token = _t0}) =>
    GradeCell.fromJson({
      'id': id,
      'grade_submission_id': 'sub-$id',
      'label': 'Midterm',
      'score': score,
      'max_score': maxScore,
      'weight': 1,
      'created_at': _t0,
      'updated_at': token,
    });

StudentGradeEntry _row(String studentId, GradeCell cell, {String status = 'draft'}) =>
    StudentGradeEntry(
      studentId: studentId,
      submissionId: cell.submissionId,
      status: GradeSubmissionStatus.fromWire(status),
      rejectionReason: null,
      cell: cell,
    );

GradeSubmission _submission(String id, {String status = 'draft', String token = _t0}) =>
    GradeSubmission.fromJson({
      'id': id,
      'gradebook_id': 'gb-1',
      'student_id': 'stu-$id',
      'status': status,
      'rejection_reason': null,
      'submitted_by_user_id': null,
      'decided_by_user_id': null,
      'submitted_at': null,
      'decided_at': null,
      'created_at': _t0,
      'updated_at': token,
      'grades': const [],
    });

class _FakeGradeEntryClient implements GradeEntryClient {
  List<GradeScoreEdit> lastBatch = const [];
  int batchCalls = 0;
  DioException? throwOnBulk;

  final List<String> submitted = [];
  final Set<String> failSubmitIds = {};

  /// What `bulkUpdateGrades` echoes back; defaults to the same ids with a bumped token.
  List<GradeCell>? bulkResult;

  @override
  Future<GradebookRef> resolveGradebook(String classId) => throw UnimplementedError();

  @override
  Future<List<GradeSubmission>> fetchEntry(String gradebookId) => throw UnimplementedError();

  @override
  Future<List<GradeSubmission>> createAssessment(
    String gradebookId, {
    required String label,
    required double maxScore,
    double weight = 1,
  }) =>
      throw UnimplementedError();

  @override
  Future<List<GradeCell>> bulkUpdateGrades(String gradebookId, List<GradeScoreEdit> edits) async {
    batchCalls++;
    lastBatch = edits;
    if (throwOnBulk != null) throw throwOnBulk!;
    return bulkResult ??
        [for (final e in edits) _cell(e.gradeId, score: e.score, token: _t1)];
  }

  @override
  Future<GradeSubmission> submitSubmission(
    String gradebookId,
    String submissionId, {
    required String updatedAt,
  }) async {
    if (failSubmitIds.contains(submissionId)) {
      throw DioException(
        requestOptions: RequestOptions(path: '/'),
        error: const ApiException(status: 409, title: 'conflict', code: 'GRADE_CONCURRENT_EDIT'),
      );
    }
    submitted.add(submissionId);
    return _submission(submissionId, status: 'submitted');
  }
}

void main() {
  late _FakeGradeEntryClient client;
  late GradeEntryController controller;

  setUp(() {
    client = _FakeGradeEntryClient();
    controller = GradeEntryController(
      client: client,
      gradebookId: 'gb-1',
      debounce: Duration.zero,
    );
  });

  tearDown(() => controller.dispose());

  test('seed populates fields from the cell scores', () {
    controller.seed([
      _row('a', _cell('g-a', score: 42)),
      _row('b', _cell('g-b')),
    ]);

    expect(controller.textFor('g-a'), '42');
    expect(controller.textFor('g-b'), '');
    expect(controller.isDirty('g-a'), isFalse);
  });

  test('an in-range edit is dirty and flushes to the API, refreshing the token', () async {
    final cell = _cell('g-a', token: _t0);
    controller.seed([_row('a', cell)]);

    controller.setText('g-a', '80', maxScore: 100);
    expect(controller.isDirty('g-a'), isTrue);
    expect(controller.status, GradeSaveStatus.pending);

    await controller.flush();

    expect(client.batchCalls, 1);
    expect(client.lastBatch.single.gradeId, 'g-a');
    expect(client.lastBatch.single.score, 80);
    expect(client.lastBatch.single.updatedAt, _t0);
    expect(controller.status, GradeSaveStatus.saved);
    expect(controller.isDirty('g-a'), isFalse);
  });

  test('an out-of-range value is flagged and never sent', () async {
    controller.seed([_row('a', _cell('g-a', maxScore: 50))]);

    controller.setText('g-a', '55', maxScore: 50);

    expect(controller.isOutOfRange('g-a', 50), isTrue);
    expect(controller.status, isNot(GradeSaveStatus.pending));

    await controller.flush();
    expect(client.batchCalls, 0);
  });

  test('a negative value is also out of range and not sent', () async {
    controller.seed([_row('a', _cell('g-a', maxScore: 50))]);
    controller.setText('g-a', '-3', maxScore: 50);
    expect(controller.isOutOfRange('g-a', 50), isTrue);
    await controller.flush();
    expect(client.batchCalls, 0);
  });

  test('a concurrent-edit conflict surfaces its code and stops the save', () async {
    controller.seed([_row('a', _cell('g-a'))]);
    client.throwOnBulk = DioException(
      requestOptions: RequestOptions(path: '/'),
      error: const ApiException(status: 409, title: 'conflict', code: 'GRADE_CONCURRENT_EDIT'),
    );

    controller.setText('g-a', '90', maxScore: 100);
    await controller.flush();

    expect(controller.status, GradeSaveStatus.error);
    expect(controller.errorCode, 'GRADE_CONCURRENT_EDIT');
  });

  test('resetDrafts drops in-progress edits', () {
    controller.seed([_row('a', _cell('g-a', score: 10))]);
    controller.setText('g-a', '11', maxScore: 100);
    expect(controller.isDirty('g-a'), isTrue);

    controller.resetDrafts();

    expect(controller.textFor('g-a'), '');
    expect(controller.status, GradeSaveStatus.idle);
  });

  test('submitAll submits every passed submission and reports failures', () async {
    client.failSubmitIds.add('s2');

    final result = await controller.submitAll([
      _submission('s1'),
      _submission('s2'),
      _submission('s3'),
    ]);

    expect(client.submitted, ['s1', 's3']);
    expect(result.submitted, 2);
    expect(result.hadFailures, isTrue);
    expect(result.failed['s2'], 'GRADE_CONCURRENT_EDIT');
  });
}
