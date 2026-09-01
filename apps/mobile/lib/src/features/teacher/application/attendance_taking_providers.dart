import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/attendance_record.dart';
import '../../../core/api/generated/models/attendance_session.dart';
import '../../../core/api/generated/models/attendance_session_status.dart';
import '../../../core/auth/auth_providers.dart';
import '../domain/attendance_taking.dart';
import 'attendance_sync_queue.dart';
import 'teacher_providers.dart';

/// Identifies one register: a class, plus the timetable period it is for (null = whole-day
/// attendance, taken from the class screen rather than a timetable session).
typedef AttendanceScope = ({String classId, int? period});

/// Everything the take-attendance screen renders from: the roster, today's session state, and any
/// locally-known records. The editable draft itself is UI state the screen owns — this provider
/// supplies only the inputs, so a pull-to-refresh re-resolves the world without discarding
/// in-progress taps.
final attendanceRegisterProvider =
    FutureProvider.family<AttendanceRegister, AttendanceScope>((ref, scope) async {
  final api = ref.watch(apiClientProvider);
  final queue = ref.watch(attendanceSyncQueueProvider);
  final today = _todayDate();

  final roster = await ref.watch(classRosterProvider(scope.classId).future);

  // `session_date` is left off the query on purpose: the generated client serialises it as a full
  // date-time, which the API's date-only filter rejects. The class filter + a small page is
  // enough to find today's session, and the list is date-descending so today's is near the top.
  final page = await api.attendance.listAttendanceSessions(classId: scope.classId, limit: 50);
  final session = _sessionForToday(page.attendanceSessions, today, scope.period);

  if (session != null &&
      (session.status == AttendanceSessionStatus.submitted ||
          session.status == AttendanceSessionStatus.locked)) {
    return RecordedRegister(
      roster: roster,
      session: session,
      records: await queue.cachedRecords(session.id),
    );
  }

  final openSession =
      session != null && session.status == AttendanceSessionStatus.open ? session : null;
  final lockedRecords = openSession == null
      ? const <AttendanceRecord>[]
      : await queue.cachedRecords(openSession.id) ?? const <AttendanceRecord>[];

  return AttendanceTakingRegister(
    roster: roster,
    openSession: openSession,
    lockedRecords: lockedRecords,
  );
});

AttendanceSession? _sessionForToday(
  List<AttendanceSession> sessions,
  DateTime today,
  int? period,
) {
  for (final session in sessions) {
    if (!_isSameDate(session.sessionDate, today)) continue;
    // A whole-day session (null period) covers any period; a period scope also matches its own.
    final matches = period == null ? session.period == null : session.period == period;
    final wholeDayCoversPeriod = period != null && session.period == null;
    if (matches || wholeDayCoversPeriod) return session;
  }
  return null;
}

bool _isSameDate(DateTime a, DateTime b) =>
    a.year == b.year && a.month == b.month && a.day == b.day;

DateTime _todayDate() {
  final now = DateTime.now();
  return DateTime(now.year, now.month, now.day);
}
