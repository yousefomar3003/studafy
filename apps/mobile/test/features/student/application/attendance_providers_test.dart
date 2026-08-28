import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_record_status.dart';
import 'package:studafy_mobile/src/features/student/application/attendance_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/attendance_history.dart';

/// [attendanceHistoryProvider] is `.autoDispose`; Riverpod only keeps its async work alive
/// while something watches it, so a bare `container.read(...future)` can be disposed mid-flight.
/// Keep this subscription open for the rest of the test — same guard the today-grades provider
/// test uses.
ProviderSubscription<AsyncValue<AttendanceHistoryStatus>> _keepAlive(
  ProviderContainer container,
) {
  return container.listen(attendanceHistoryProvider, (previous, next) {});
}

void main() {
  test('resolves AttendanceHistoryUnavailable while the records seam is unfilled', () async {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    _keepAlive(container);

    final status = await container.read(attendanceHistoryProvider.future);

    expect(status, isA<AttendanceHistoryUnavailable>());
  });

  test('assembles the overridden records into AttendanceHistoryReady', () async {
    final container = ProviderContainer(
      overrides: [
        studentAttendanceRecordsProvider.overrideWith(
          (ref) async => [
            StudentAttendanceEntry(
              date: DateTime(2026, 8, 26),
              status: AttendanceRecordStatus.absent,
              reason: 'Family emergency',
            ),
            StudentAttendanceEntry(
              date: DateTime(2026, 8, 4),
              status: AttendanceRecordStatus.present,
            ),
            StudentAttendanceEntry(
              date: DateTime(2026, 7, 15),
              status: AttendanceRecordStatus.valueLate,
              minutesLate: 12,
            ),
          ],
        ),
      ],
    );
    addTearDown(container.dispose);
    _keepAlive(container);

    final status = await container.read(attendanceHistoryProvider.future);

    expect(status, isA<AttendanceHistoryReady>());
    final history = (status as AttendanceHistoryReady).history;
    expect(history.months.map((month) => month.month), [
      DateTime(2026, 8),
      DateTime(2026, 7),
    ]);
    expect(history.months.first.absentCount, 1);
    expect(history.months.first.exceptions.single.reason, 'Family emergency');
    expect(history.months.last.lateCount, 1);
  });

  test('an empty record list is Ready-and-empty, not Unavailable', () async {
    final container = ProviderContainer(
      overrides: [
        studentAttendanceRecordsProvider.overrideWith((ref) async => const []),
      ],
    );
    addTearDown(container.dispose);
    _keepAlive(container);

    final status = await container.read(attendanceHistoryProvider.future);

    expect(status, isA<AttendanceHistoryReady>());
    expect((status as AttendanceHistoryReady).history.isEmpty, isTrue);
  });
}
