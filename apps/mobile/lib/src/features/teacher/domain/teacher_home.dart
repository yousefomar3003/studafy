import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/attendance_session.dart';
import '../../../core/api/generated/models/attendance_session_status.dart';
import '../../../core/api/generated/models/submission.dart';
import '../../../core/api/generated/models/timetable_slot.dart';

/// Where today's attendance stands for one teaching session. Drives the take-attendance CTA's
/// label and whether it still invites action.
enum SessionAttendanceState {
  /// No attendance session has been opened for this class and period today.
  notStarted,

  /// A session exists but is still `draft` or `open` — attendance can still be taken or finished.
  inProgress,

  /// Attendance has been `submitted` or `locked` for today; nothing left to do.
  recorded;

  bool get invitesAction => this != SessionAttendanceState.recorded;

  /// Resolves the state from the attendance sessions already recorded for a class on a date,
  /// matching [period]. A session with a null period (whole-day) counts for any period.
  static SessionAttendanceState fromSessions(
    Iterable<AttendanceSession> sessions,
    int period,
  ) {
    final match = sessions
        .where((session) => session.period == null || session.period == period)
        .toList();
    if (match.isEmpty) return SessionAttendanceState.notStarted;

    return switch (match.first.status) {
      AttendanceSessionStatus.submitted ||
      AttendanceSessionStatus.locked => SessionAttendanceState.recorded,
      AttendanceSessionStatus.cancelled => SessionAttendanceState.notStarted,
      _ => SessionAttendanceState.inProgress,
    };
  }
}

/// One session on the signed-in teacher's timetable for today, resolved from the current term's
/// approved timetable version.
class TeacherSession {
  const TeacherSession({
    required this.slot,
    required this.classCode,
    required this.attendance,
  });

  final TimetableSlot slot;

  /// The class's short code (e.g. `MATH101-A`), resolved for display instead of [slot.classId].
  final String classCode;

  final SessionAttendanceState attendance;

  String get classId => slot.classId;

  int get period => slot.period;
}

/// A turned-in submission across the teacher's assignments that still needs a mark
/// (`grade_status = none`), paired with its assignment for display.
class PendingSubmission {
  const PendingSubmission({required this.submission, required this.assignment});

  final Submission submission;
  final Assignment assignment;

  /// Non-null by construction — [PendingSubmission]s are only built from submissions that have
  /// actually been handed in.
  DateTime get submittedAt => submission.submittedAt!;
}
