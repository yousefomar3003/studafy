import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/batch_record_item_status.dart';
import 'package:studafy_mobile/src/features/teacher/domain/attendance_sync.dart';

QueuedAttendanceSubmission _submission({
  String classId = 'class-1',
  int? period = 2,
  DateTime? sessionDate,
  List<QueuedMark>? records,
}) => QueuedAttendanceSubmission(
  classId: classId,
  sessionDate: sessionDate ?? DateTime(2026, 9, 1),
  period: period,
  records: records ??
      const [
        QueuedMark(studentId: 's1', status: BatchRecordItemStatus.present),
        QueuedMark(studentId: 's2', status: BatchRecordItemStatus.valueLate, minutesLate: 5),
      ],
  queuedAt: DateTime(2026, 9, 1, 8, 30),
);

void main() {
  group('queueKey', () {
    test('is stable for the same class, date and period', () {
      expect(
        _submission().queueKey,
        _submission(sessionDate: DateTime(2026, 9, 1, 23, 59)).queueKey,
      );
    });

    test('differs by period, and a null period reads as "day"', () {
      expect(_submission(period: 2).queueKey, 'class-1|2026-09-01|2');
      expect(_submission(period: 3).queueKey, 'class-1|2026-09-01|3');
      expect(_submission(period: null).queueKey, 'class-1|2026-09-01|day');
    });
  });

  group('json round-trip', () {
    test('preserves every field', () {
      final original = _submission().recordAttempt(error: 'timeout');
      final restored = QueuedAttendanceSubmission.fromJson(original.toJson());

      expect(restored.classId, original.classId);
      expect(restored.period, original.period);
      expect(restored.sessionDate, DateTime(2026, 9, 1));
      expect(restored.queuedAt, original.queuedAt);
      expect(restored.attempts, 1);
      expect(restored.lastError, 'timeout');
      expect(restored.records.map((r) => r.studentId), ['s1', 's2']);
      expect(restored.records[1].status, BatchRecordItemStatus.valueLate);
      expect(restored.records[1].minutesLate, 5);
    });

    test('recordAttempt increments the counter and keeps the payload', () {
      final once = _submission().recordAttempt(error: 'a');
      final twice = once.recordAttempt(error: 'b');
      expect(once.attempts, 1);
      expect(twice.attempts, 2);
      expect(twice.records.length, 2);
      expect(twice.queueKey, _submission().queueKey);
    });
  });
}
