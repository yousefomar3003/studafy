import '../../../core/api/generated/models/attendance_record_status.dart';

/// One attendance record from the student's own history: the educational date it was taken for,
/// the state the teacher recorded, and — for the states that carry one — how many minutes late
/// and the free-text reason.
///
/// [date] is the session's `session_date` (the day attendance is _for_), normalised to a local
/// midnight so month grouping in [assembleAttendanceHistory] is date-only and never shifts a
/// record across a month boundary on a timezone offset.
class StudentAttendanceEntry {
  const StudentAttendanceEntry({
    required this.date,
    required this.status,
    this.minutesLate,
    this.reason,
  });

  final DateTime date;
  final AttendanceRecordStatus status;

  /// Non-null only when [status] is [AttendanceRecordStatus.valueLate] — mirrors the API's
  /// `minutes_late` contract.
  final int? minutesLate;

  /// The teacher's note on an absence, lateness, or excusal. Null when none was recorded.
  final String? reason;

  /// Whether this entry is one the screen surfaces in the month's detail list: every state
  /// except a plain on-time attendance. "remote" is counted as attendance, not an exception.
  bool get isException =>
      status != AttendanceRecordStatus.present && status != AttendanceRecordStatus.remote;
}

/// The outcome of loading the student attendance screen, once loading itself has finished — the
/// same ready/unavailable split [TimetableWeekStatus](`timetable_week.dart`) uses, for the same
/// reason.
///
/// [AttendanceHistoryUnavailable] is a distinct non-error state: there is no student-facing
/// attendance endpoint yet (see [studentAttendanceRecordsProvider] in
/// `../application/attendance_providers.dart`), so an unresolved history is a known gap, not a
/// failed fetch.
sealed class AttendanceHistoryStatus {
  const AttendanceHistoryStatus();
}

class AttendanceHistoryReady extends AttendanceHistoryStatus {
  const AttendanceHistoryReady(this.history);

  final AttendanceHistory history;
}

class AttendanceHistoryUnavailable extends AttendanceHistoryStatus {
  const AttendanceHistoryUnavailable();
}

/// The student's attendance history, grouped into calendar months, newest month first.
class AttendanceHistory {
  const AttendanceHistory({required this.months});

  final List<AttendanceMonth> months;

  bool get isEmpty => months.isEmpty;
}

/// One calendar month of attendance: its records newest day first, plus the present/absent/
/// late/excused tallies and rate the monthly summary is built from.
class AttendanceMonth {
  AttendanceMonth({required this.month, required this.entries});

  /// Local midnight of the first day of the month, so two months sort and compare by value.
  final DateTime month;

  /// This month's records, newest day first.
  final List<StudentAttendanceEntry> entries;

  int get totalCount => entries.length;

  int _countOf(AttendanceRecordStatus status) =>
      entries.where((entry) => entry.status == status).length;

  /// Days physically or virtually in class — a plain attendance plus any recorded as `remote`.
  int get presentCount =>
      _countOf(AttendanceRecordStatus.present) + _countOf(AttendanceRecordStatus.remote);

  int get absentCount => _countOf(AttendanceRecordStatus.absent);

  int get lateCount => _countOf(AttendanceRecordStatus.valueLate);

  int get excusedCount => _countOf(AttendanceRecordStatus.excused);

  /// Share of the month's recorded days the student showed up for — present, remote, or late
  /// (a late arrival still attended). Over [totalCount], so an excused day still counts against
  /// it; the summary line breaks the states out for the reader. 0 when nothing is recorded.
  double get attendanceRate =>
      totalCount == 0 ? 0 : (presentCount + lateCount) / totalCount;

  /// The records the screen lists under the summary: every non-present day, in [entries] order.
  List<StudentAttendanceEntry> get exceptions =>
      entries.where((entry) => entry.isException).toList();
}

/// Groups flat [entries] into [AttendanceMonth]s, newest month and newest day first. Pure — no
/// clock, no I/O — so the grouping and the summary maths are unit-testable on their own, the
/// same shape as `assembleTimetableWeek` (`timetable_week.dart`).
AttendanceHistory assembleAttendanceHistory({
  required List<StudentAttendanceEntry> entries,
}) {
  final byMonth = <DateTime, List<StudentAttendanceEntry>>{};
  for (final entry in entries) {
    final monthKey = DateTime(entry.date.year, entry.date.month);
    byMonth.putIfAbsent(monthKey, () => []).add(entry);
  }

  final months = byMonth.keys.toList()..sort((a, b) => b.compareTo(a));

  return AttendanceHistory(
    months: [
      for (final month in months)
        AttendanceMonth(
          month: month,
          entries: byMonth[month]!..sort((a, b) => b.date.compareTo(a.date)),
        ),
    ],
  );
}
