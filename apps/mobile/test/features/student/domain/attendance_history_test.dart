import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_record_status.dart';
import 'package:studafy_mobile/src/features/student/domain/attendance_history.dart';

StudentAttendanceEntry _entry(
  DateTime date,
  AttendanceRecordStatus status, {
  int? minutesLate,
  String? reason,
}) {
  return StudentAttendanceEntry(
    date: date,
    status: status,
    minutesLate: minutesLate,
    reason: reason,
  );
}

void main() {
  group('assembleAttendanceHistory', () {
    test('groups entries into months, newest month first', () {
      final history = assembleAttendanceHistory(
        entries: [
          _entry(DateTime(2026, 6, 3), AttendanceRecordStatus.present),
          _entry(DateTime(2026, 8, 12), AttendanceRecordStatus.present),
          _entry(DateTime(2026, 7, 20), AttendanceRecordStatus.present),
        ],
      );

      expect(
        history.months.map((month) => month.month),
        [DateTime(2026, 8), DateTime(2026, 7), DateTime(2026, 6)],
      );
    });

    test('orders each month newest day first', () {
      final history = assembleAttendanceHistory(
        entries: [
          _entry(DateTime(2026, 8, 4), AttendanceRecordStatus.present),
          _entry(DateTime(2026, 8, 26), AttendanceRecordStatus.absent),
          _entry(DateTime(2026, 8, 15), AttendanceRecordStatus.valueLate),
        ],
      );

      expect(
        history.months.single.entries.map((entry) => entry.date),
        [DateTime(2026, 8, 26), DateTime(2026, 8, 15), DateTime(2026, 8, 4)],
      );
    });

    test('tallies each status, counting remote as present', () {
      final month = assembleAttendanceHistory(
        entries: [
          _entry(DateTime(2026, 8, 1), AttendanceRecordStatus.present),
          _entry(DateTime(2026, 8, 2), AttendanceRecordStatus.remote),
          _entry(DateTime(2026, 8, 3), AttendanceRecordStatus.absent),
          _entry(DateTime(2026, 8, 4), AttendanceRecordStatus.valueLate, minutesLate: 15),
          _entry(DateTime(2026, 8, 5), AttendanceRecordStatus.excused, reason: 'Doctor'),
          _entry(DateTime(2026, 8, 6), AttendanceRecordStatus.absent),
        ],
      ).months.single;

      expect(month.totalCount, 6);
      expect(month.presentCount, 2);
      expect(month.absentCount, 2);
      expect(month.lateCount, 1);
      expect(month.excusedCount, 1);
    });

    test('attendance rate counts present, remote and late over the total', () {
      final month = assembleAttendanceHistory(
        entries: [
          _entry(DateTime(2026, 8, 1), AttendanceRecordStatus.present),
          _entry(DateTime(2026, 8, 2), AttendanceRecordStatus.valueLate, minutesLate: 5),
          _entry(DateTime(2026, 8, 3), AttendanceRecordStatus.absent),
          _entry(DateTime(2026, 8, 4), AttendanceRecordStatus.excused),
        ],
      ).months.single;

      expect(month.attendanceRate, 0.5);
    });

    test('a fully-present month reports a rate of 1 and no exceptions', () {
      final month = assembleAttendanceHistory(
        entries: [
          _entry(DateTime(2026, 8, 1), AttendanceRecordStatus.present),
          _entry(DateTime(2026, 8, 2), AttendanceRecordStatus.remote),
        ],
      ).months.single;

      expect(month.attendanceRate, 1);
      expect(month.exceptions, isEmpty);
    });

    test('exceptions are every non-present, non-remote day in entry order', () {
      final month = assembleAttendanceHistory(
        entries: [
          _entry(DateTime(2026, 8, 1), AttendanceRecordStatus.present),
          _entry(DateTime(2026, 8, 10), AttendanceRecordStatus.absent),
          _entry(DateTime(2026, 8, 20), AttendanceRecordStatus.excused),
          _entry(DateTime(2026, 8, 25), AttendanceRecordStatus.valueLate, minutesLate: 8),
        ],
      ).months.single;

      expect(
        month.exceptions.map((entry) => entry.status),
        [
          AttendanceRecordStatus.valueLate,
          AttendanceRecordStatus.excused,
          AttendanceRecordStatus.absent,
        ],
      );
    });

    test('no entries yields an empty history', () {
      final history = assembleAttendanceHistory(entries: const []);

      expect(history.isEmpty, isTrue);
      expect(history.months, isEmpty);
    });

    test('an empty month has a zero rate rather than dividing by zero', () {
      final month = AttendanceMonth(month: DateTime(2026, 8), entries: const []);

      expect(month.attendanceRate, 0);
    });
  });
}
