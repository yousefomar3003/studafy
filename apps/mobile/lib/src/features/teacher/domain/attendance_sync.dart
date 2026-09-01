import '../../../core/api/generated/models/batch_record_item.dart';
import '../../../core/api/generated/models/batch_record_item_status.dart';

/// One student's mark inside a [QueuedAttendanceSubmission]. A wire-shaped copy of
/// [AttendanceMark], decoupled so the outbox payload doesn't move when the UI model does.
class QueuedMark {
  const QueuedMark({required this.studentId, required this.status, this.minutesLate});

  final String studentId;
  final BatchRecordItemStatus status;
  final int? minutesLate;

  BatchRecordItem toBatchItem() => BatchRecordItem(
    studentId: studentId,
    status: status,
    minutesLate: minutesLate,
  );

  Map<String, Object?> toJson() => {
    'student_id': studentId,
    'status': status.json,
    if (minutesLate != null) 'minutes_late': minutesLate,
  };

  factory QueuedMark.fromJson(Map<String, Object?> json) => QueuedMark(
    studentId: json['student_id']! as String,
    status: BatchRecordItemStatus.fromJson(json['status']! as String),
    minutesLate: (json['minutes_late'] as num?)?.toInt(),
  );
}

/// A batch attendance submission persisted to the local outbox so it survives a failed send and
/// replays when connectivity returns.
///
/// Replay is exactly-once by construction, without a client-generated idempotency token:
///
///  * [queueKey] is deterministic — the same class, date and period always produce the same key —
///    so re-queuing a register overwrites its predecessor rather than adding a second job.
///  * Opening the session is idempotent on exactly that `(class, date, period)` tuple server-side,
///    so a replay reuses the existing session.
///  * Recording is idempotent per `(session, student)` — a replay skips students already written.
///
/// A crash mid-send therefore replays safely: whatever reached the server is not written twice,
/// and whatever didn't is retried.
class QueuedAttendanceSubmission {
  const QueuedAttendanceSubmission({
    required this.classId,
    required this.sessionDate,
    required this.period,
    required this.records,
    required this.queuedAt,
    this.attempts = 0,
    this.lastError,
  });

  final String classId;

  /// The educational business date, normalised to midnight. Serialised as `YYYY-MM-DD`.
  final DateTime sessionDate;

  /// Timetable period, or null for whole-day attendance.
  final int? period;

  final List<QueuedMark> records;
  final DateTime queuedAt;

  /// How many times a flush has been attempted for this entry. Advisory — used for diagnostics
  /// and to order retries, not to cap them.
  final int attempts;

  /// The last transient failure's message, if any.
  final String? lastError;

  /// Stable identity for this queued register. Also the cache key it is stored under, so the
  /// outbox holds at most one entry per class/date/period.
  String get queueKey => [classId, _ymd(sessionDate), period?.toString() ?? 'day'].join('|');

  QueuedAttendanceSubmission recordAttempt({String? error}) => QueuedAttendanceSubmission(
    classId: classId,
    sessionDate: sessionDate,
    period: period,
    records: records,
    queuedAt: queuedAt,
    attempts: attempts + 1,
    lastError: error,
  );

  Map<String, Object?> toJson() => {
    'class_id': classId,
    'session_date': _ymd(sessionDate),
    'period': period,
    'records': [for (final record in records) record.toJson()],
    'queued_at': queuedAt.toIso8601String(),
    'attempts': attempts,
    'last_error': lastError,
  };

  factory QueuedAttendanceSubmission.fromJson(Map<String, Object?> json) =>
      QueuedAttendanceSubmission(
        classId: json['class_id']! as String,
        sessionDate: DateTime.parse(json['session_date']! as String),
        period: (json['period'] as num?)?.toInt(),
        records: [
          for (final record in json['records']! as List<Object?>)
            QueuedMark.fromJson(record! as Map<String, Object?>),
        ],
        queuedAt: DateTime.parse(json['queued_at']! as String),
        attempts: (json['attempts'] as num?)?.toInt() ?? 0,
        lastError: json['last_error'] as String?,
      );
}

String _ymd(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-'
    '${date.month.toString().padLeft(2, '0')}-'
    '${date.day.toString().padLeft(2, '0')}';
