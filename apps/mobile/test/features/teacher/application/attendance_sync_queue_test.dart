import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_record.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_session.dart';
import 'package:studafy_mobile/src/core/api/generated/models/batch_record_item_status.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/features/teacher/application/attendance_sync_queue.dart';
import 'package:studafy_mobile/src/features/teacher/domain/attendance_sync.dart';

import '../support.dart';

const _t0 = '2026-01-01T00:00:00.000Z';

QueuedAttendanceSubmission _submission({int marks = 2, int? period = 2}) =>
    QueuedAttendanceSubmission(
      classId: 'class-1',
      sessionDate: DateTime(2026, 9, 1),
      period: period,
      records: [
        for (var i = 0; i < marks; i++)
          QueuedMark(studentId: 's$i', status: BatchRecordItemStatus.present),
      ],
      queuedAt: DateTime(2026, 9, 1, 8),
    );

DioException _networkError() => DioException(
  requestOptions: RequestOptions(path: '/api/attendance/sessions'),
  type: DioExceptionType.connectionError,
);

DioException _apiError(int status, String code) => DioException(
  requestOptions: RequestOptions(path: '/api/attendance/sessions'),
  error: ApiException(status: status, title: 'rejected', code: code),
);

void main() {
  late OfflineDatabase database;
  late FakeAttendanceClient client;
  late AttendanceSyncQueue queue;

  setUp(() {
    database = OfflineDatabase(NativeDatabase.memory());
    client = FakeAttendanceClient();
    queue = AttendanceSyncQueue(database: database, client: client);
  });

  tearDown(() => database.close());

  group('outbox', () {
    test('enqueue then pending returns the submission; a second enqueue overwrites', () async {
      await queue.enqueue(_submission());
      await queue.enqueue(_submission(marks: 4));

      final pending = await queue.pending();
      expect(pending, hasLength(1));
      expect(pending.single.records, hasLength(4));
    });

    test('pendingFor matches on class and period', () async {
      await queue.enqueue(_submission(period: 2));
      expect(
        await queue.pendingFor(classId: 'class-1', period: 2),
        isNotNull,
      );
      expect(await queue.pendingFor(classId: 'class-1', period: 3), isNull);
    });
  });

  group('flushOne', () {
    test('opens the session, records the batch, submits it, caches records, clears the outbox',
        () async {
      await queue.enqueue(_submission());

      final outcome = await queue.flushOne(_submission());

      expect(outcome, isA<AttendanceRecorded>());
      final recorded = outcome as AttendanceRecorded;
      expect(client.batchCalls, hasLength(1));
      expect(client.submittedSessionIds, [recorded.sessionId]);
      expect(await queue.pending(), isEmpty);
      expect(await queue.cachedRecords(recorded.sessionId), isNotNull);
    });

    test('chunks a roster larger than the batch cap into consecutive calls', () async {
      final big = _submission(marks: 120);
      await queue.enqueue(big);

      await queue.flushOne(big);

      expect(client.batchCalls.map((c) => c.records.length), [50, 50, 20]);
    });

    test('a session already submitted on open is treated as done', () async {
      client.sessionsByClassId = {
        'class-1': [
          AttendanceSession.fromJson(_sessionJson('session-1', status: 'submitted', period: 2)),
        ],
      };
      await queue.enqueue(_submission());

      final outcome = await queue.flushOne(_submission());

      expect(outcome, isA<AttendanceRecorded>());
      expect(client.batchCalls, isEmpty);
      expect(await queue.pending(), isEmpty);
    });

    test('a network failure keeps the entry and defers with an incremented attempt', () async {
      client.throwOnWrite = _networkError();
      await queue.enqueue(_submission());

      final outcome = await queue.flushOne(_submission());

      expect(outcome, isA<AttendanceSyncDeferred>());
      expect((outcome as AttendanceSyncDeferred).reason, AttendanceDeferReason.offline);
      final pending = await queue.pending();
      expect(pending, hasLength(1));
      expect(pending.single.attempts, 1);
    });

    test('a 4xx rejection drops the entry', () async {
      client.throwOnWrite = _apiError(400, 'ATTENDANCE_STUDENT_NOT_IN_CLASS');
      await queue.enqueue(_submission());

      final outcome = await queue.flushOne(_submission());

      expect(outcome, isA<AttendanceSyncRejected>());
      expect((outcome as AttendanceSyncRejected).code, 'ATTENDANCE_STUDENT_NOT_IN_CLASS');
      expect(await queue.pending(), isEmpty);
    });

    test('replaying after a partial success does not double-record', () async {
      await queue.enqueue(_submission());
      await queue.flushOne(_submission());
      final firstBatchCount = client.batchCalls.length;

      // Nothing left queued, and a re-run finds the session already submitted.
      final replay = await queue.flushOne(_submission());

      expect(replay, isA<AttendanceRecorded>());
      expect(client.batchCalls.length, firstBatchCount);
    });
  });

  group('flushAll', () {
    test('stops at the first transient failure and keeps the remaining entries', () async {
      await queue.enqueue(_submission(period: 2));
      await queue.enqueue(_submission(period: 3));
      client.throwOnWrite = _networkError();

      final report = await queue.flushAll();

      expect(report.recorded, 0);
      expect(report.deferred, isTrue);
      expect(await queue.pending(), hasLength(2));
    });
  });

  group('replaceCachedRecord', () {
    test('swaps one record in the cached set by id', () async {
      await queue.enqueue(_submission());
      final recorded = await queue.flushOne(_submission()) as AttendanceRecorded;
      final target = recorded.records.first;

      final corrected = AttendanceRecord.fromJson({
        ...target.toJson(),
        'status': 'excused',
      });
      await queue.replaceCachedRecord(recorded.sessionId, corrected);

      final cached = await queue.cachedRecords(recorded.sessionId);
      expect(cached!.firstWhere((r) => r.id == target.id).status.json, 'excused');
    });
  });
}

Map<String, Object?> _sessionJson(String id, {required String status, int? period}) => {
  'id': id,
  'school_id': 'school-1',
  'class_id': 'class-1',
  'session_date': _t0,
  'period': period,
  'status': status,
  'taken_by_user_id': 'user-1',
  'created_at': _t0,
  'updated_at': _t0,
};
