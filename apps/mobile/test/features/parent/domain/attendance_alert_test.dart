import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_report_metrics.dart';
import 'package:studafy_mobile/src/features/parent/domain/attendance_alert.dart';

AttendanceReportMetrics metrics({
  int totalRecords = 40,
  int absentCount = 0,
  num absentPercent = 0,
}) =>
    AttendanceReportMetrics.fromJson({
      'total_records': totalRecords,
      'present_count': totalRecords - absentCount,
      'absent_count': absentCount,
      'late_count': 0,
      'excused_count': 0,
      'present_percent': totalRecords == 0 ? 0 : 100 - absentPercent,
      'absent_percent': absentPercent,
      'late_percent': 0,
      'excused_percent': 0,
    });

void main() {
  group('AttendanceAlert.fromMetrics', () {
    test('a term with no records reads as on track, not an alert', () {
      expect(
        AttendanceAlert.fromMetrics(metrics(totalRecords: 0)),
        AttendanceAlert.onTrack,
      );
    });

    test('a clean attendance record is on track', () {
      expect(AttendanceAlert.fromMetrics(metrics(absentCount: 0)), AttendanceAlert.onTrack);
    });

    test('any absence below the chronic threshold is a watch', () {
      expect(
        AttendanceAlert.fromMetrics(metrics(absentCount: 2, absentPercent: 5)),
        AttendanceAlert.watch,
      );
    });

    test('absence exactly at the chronic threshold needs attention', () {
      expect(
        AttendanceAlert.fromMetrics(metrics(absentCount: 4, absentPercent: 10)),
        AttendanceAlert.needsAttention,
      );
    });

    test('heavy absence needs attention', () {
      expect(
        AttendanceAlert.fromMetrics(metrics(absentCount: 10, absentPercent: 25)),
        AttendanceAlert.needsAttention,
      );
    });

    test('isElevated is true for everything except on track', () {
      expect(AttendanceAlert.onTrack.isElevated, isFalse);
      expect(AttendanceAlert.watch.isElevated, isTrue);
      expect(AttendanceAlert.needsAttention.isElevated, isTrue);
    });
  });
}
