import '../../../core/api/generated/models/attendance_record.dart';
import '../../../core/api/generated/models/attendance_record_status.dart';
import '../../../core/api/generated/models/attendance_session.dart';
import '../../../core/api/generated/models/batch_record_item_status.dart';
import '../../../core/api/generated/models/enrollment.dart';

/// The attendance states a teacher can assign from the take-attendance screen by tapping a row.
///
/// A deliberately small set: `remote` (a valid wire status) is not offered here because it is not
/// part of the two-tap flow and would only lengthen the tap cycle. It stays reachable through the
/// correction sheet, which exposes every [AttendanceRecordStatus].
enum AttendanceMarkStatus {
  present,
  absent,
  late,
  excused;

  /// The next state in the tap cycle: present → absent → late → excused → present. A single tap
  /// on a roster row advances by one, so the common "mark the three absentees" pass is one tap
  /// each and the whole-class default needs no taps at all.
  AttendanceMarkStatus get next => switch (this) {
    AttendanceMarkStatus.present => AttendanceMarkStatus.absent,
    AttendanceMarkStatus.absent => AttendanceMarkStatus.late,
    AttendanceMarkStatus.late => AttendanceMarkStatus.excused,
    AttendanceMarkStatus.excused => AttendanceMarkStatus.present,
  };

  BatchRecordItemStatus get wireStatus => switch (this) {
    AttendanceMarkStatus.present => BatchRecordItemStatus.present,
    AttendanceMarkStatus.absent => BatchRecordItemStatus.absent,
    AttendanceMarkStatus.late => BatchRecordItemStatus.valueLate,
    AttendanceMarkStatus.excused => BatchRecordItemStatus.excused,
  };

  /// The nearest editable state for an already-recorded [status]. `remote` and any wire value
  /// newer than this build collapse to [present] — they can't be represented on the tap cycle,
  /// and a recorded row is shown read-only anyway (see [AttendanceTakingRegister.lockedStudentIds]),
  /// so this only ever seeds a starting point for a correction.
  static AttendanceMarkStatus fromRecord(AttendanceRecordStatus status) => switch (status) {
    AttendanceRecordStatus.present => AttendanceMarkStatus.present,
    AttendanceRecordStatus.absent => AttendanceMarkStatus.absent,
    AttendanceRecordStatus.valueLate => AttendanceMarkStatus.late,
    AttendanceRecordStatus.excused => AttendanceMarkStatus.excused,
    AttendanceRecordStatus.remote => AttendanceMarkStatus.present,
    AttendanceRecordStatus.$unknown => AttendanceMarkStatus.present,
  };
}

/// The minimum minutes-late the API accepts for a `late` record (`minutes_late >= 1`). Cycling a
/// row into [AttendanceMarkStatus.late] seeds this value; the row's stepper adjusts it.
const int kMinMinutesLate = 1;

/// One student's mark in a register that has not been submitted yet.
class AttendanceMark {
  const AttendanceMark({required this.studentId, required this.status, this.minutesLate});

  final String studentId;
  final AttendanceMarkStatus status;

  /// Only meaningful for [AttendanceMarkStatus.late]; null otherwise. Always `>= [kMinMinutesLate]`
  /// when set.
  final int? minutesLate;

  /// Every roster student starts here — the default-present roster is what makes the 30-second
  /// target reachable.
  factory AttendanceMark.present(String studentId) =>
      AttendanceMark(studentId: studentId, status: AttendanceMarkStatus.present);

  /// Advances [status] by one step in the tap cycle, attaching (or dropping) [minutesLate] so it
  /// is present exactly when the new status is `late`.
  AttendanceMark cycled() {
    final nextStatus = status.next;
    return AttendanceMark(
      studentId: studentId,
      status: nextStatus,
      minutesLate: nextStatus == AttendanceMarkStatus.late ? kMinMinutesLate : null,
    );
  }

  AttendanceMark withMinutesLate(int minutes) => AttendanceMark(
    studentId: studentId,
    status: status,
    minutesLate: minutes < kMinMinutesLate ? kMinMinutesLate : minutes,
  );
}

/// A running count of the marks in a draft register, for the submit bar's summary line.
class AttendanceTally {
  const AttendanceTally({
    required this.present,
    required this.absent,
    required this.late,
    required this.excused,
  });

  final int present;
  final int absent;
  final int late;
  final int excused;

  int get total => present + absent + late + excused;

  factory AttendanceTally.of(Iterable<AttendanceMark> marks) {
    var present = 0, absent = 0, late = 0, excused = 0;
    for (final mark in marks) {
      switch (mark.status) {
        case AttendanceMarkStatus.present:
          present++;
        case AttendanceMarkStatus.absent:
          absent++;
        case AttendanceMarkStatus.late:
          late++;
        case AttendanceMarkStatus.excused:
          excused++;
      }
    }
    return AttendanceTally(present: present, absent: absent, late: late, excused: excused);
  }
}

/// Everything the take-attendance screen needs to render, resolved from the roster, today's
/// attendance session (if any), and the local records cache. One of two shapes:
///
///  * [AttendanceTakingRegister] — nothing submitted yet; the screen shows an editable roster and
///    a submit action.
///  * [RecordedRegister] — today's session is `submitted`/`locked`; the screen shows the recorded
///    states and, where the records are known, a correction affordance.
///
/// The split mirrors the API's own model: a `draft`/`open` session "is still being taken and
/// `POST /records/batch` owns that state", while corrections apply only once a session is
/// `submitted` or `locked` (see `docs/api/attendance-correction-api.md`).
sealed class AttendanceRegister {
  const AttendanceRegister({required this.roster});

  /// Active enrolments for the class, oldest enrolment first (as [classRosterProvider] returns).
  final List<Enrollment> roster;
}

/// The register still being taken. [openSession] is non-null only when an `open` session already
/// exists (e.g. taking was interrupted); [lockedRecords] are the students already written to that
/// open session — the batch endpoint silently skips them on resubmit, so the screen shows them
/// read-only rather than pretending they are still editable.
class AttendanceTakingRegister extends AttendanceRegister {
  const AttendanceTakingRegister({
    required super.roster,
    this.openSession,
    this.lockedRecords = const [],
  });

  final AttendanceSession? openSession;
  final List<AttendanceRecord> lockedRecords;

  Set<String> get lockedStudentIds => {for (final record in lockedRecords) record.studentId};

  /// The students whose marks the teacher can still set — the roster minus [lockedStudentIds].
  Iterable<Enrollment> get editableRoster =>
      roster.where((enrolment) => !lockedStudentIds.contains(enrolment.studentId));
}

/// Today's attendance has been submitted. [records] is the recorded set when it is known — either
/// from the batch response this device sent, or the local cache written after a successful sync —
/// and null when the session was submitted elsewhere and never cached here, in which case the
/// screen can show only that attendance is recorded, not correct it.
class RecordedRegister extends AttendanceRegister {
  const RecordedRegister({
    required super.roster,
    required this.session,
    required this.records,
  });

  final AttendanceSession session;
  final List<AttendanceRecord>? records;

  bool get canCorrect => records != null && records!.isNotEmpty;
}
