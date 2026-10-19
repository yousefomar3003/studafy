import '../../../core/api/generated/models/academic_year.dart';
import '../../../core/api/generated/models/academic_year_status.dart';
import '../../../core/api/generated/models/attendance_record.dart';
import '../../../core/api/generated/models/attendance_session.dart';
import '../../../core/api/generated/models/attendance_session_status.dart';
import '../../../core/api/generated/models/class.dart';
import '../../../core/api/generated/models/term.dart';
import '../../teacher/domain/attendance_taking.dart';

/// Where one class's daily register stands on a given date — the attendance office's unit of
/// work. Mirrors `registerState` in `apps/web/src/features/attendance-office/AttendanceOfficePage.tsx`.
enum RegisterState {
  /// No daily session exists for the class on that date.
  notStarted,

  /// A session is open (or still draft) — e.g. a teacher started it on mobile — but not submitted.
  inProgress,

  /// The session is `submitted` or `locked`: recorded, and only correctable from here on.
  submitted;

  static RegisterState of(AttendanceSession? session) {
    if (session == null) return RegisterState.notStarted;
    return isSubmittedSession(session)
        ? RegisterState.submitted
        : RegisterState.inProgress;
  }
}

/// Whether [session] is past taking: records on it can only change through a correction.
bool isSubmittedSession(AttendanceSession session) =>
    session.status == AttendanceSessionStatus.submitted ||
    session.status == AttendanceSessionStatus.locked;

/// One class row on the Registers tab.
class ClassRegisterSummary {
  const ClassRegisterSummary({required this.classInfo, required this.session});

  final Class classInfo;

  /// The class's daily (period-less, non-cancelled) session on the chosen date, if any.
  final AttendanceSession? session;

  RegisterState get state => RegisterState.of(session);
}

/// The summary chips above the class list.
class RegisterCounts {
  const RegisterCounts({
    required this.notStarted,
    required this.inProgress,
    required this.submitted,
  });

  final int notStarted;
  final int inProgress;
  final int submitted;

  int get total => notStarted + inProgress + submitted;

  factory RegisterCounts.of(Iterable<ClassRegisterSummary> registers) {
    var notStarted = 0, inProgress = 0, submitted = 0;
    for (final register in registers) {
      switch (register.state) {
        case RegisterState.notStarted:
          notStarted++;
        case RegisterState.inProgress:
          inProgress++;
        case RegisterState.submitted:
          submitted++;
      }
    }
    return RegisterCounts(
      notStarted: notStarted,
      inProgress: inProgress,
      submitted: submitted,
    );
  }
}

/// The terms the office can switch between, and the one currently shown.
class TermSelection {
  const TermSelection({required this.terms, required this.term});

  /// Every term of the current academic year, earliest first.
  final List<Term> terms;

  /// Null only when the year has no terms at all.
  final Term? term;
}

/// The active academic year, else the latest-starting one. Same rule as `pickCurrentYear` in
/// `apps/web/src/features/principal/school/queries.ts`.
AcademicYear? pickCurrentYear(List<AcademicYear> years) {
  for (final year in years) {
    if (year.status == AcademicYearStatus.active) return year;
  }
  if (years.isEmpty) return null;
  return ([...years]..sort((a, b) => b.startsOn.compareTo(a.startsOn))).first;
}

/// The term containing [today], else the next one to start, else the most recent. Same rule as
/// the web's `pickCurrentTerm`.
Term? pickCurrentTerm(List<Term> terms, DateTime today) {
  if (terms.isEmpty) return null;
  final day = dateOnly(today);
  final ordered = [...terms]..sort((a, b) => a.startsOn.compareTo(b.startsOn));
  for (final term in ordered) {
    if (!dateOnly(term.startsOn).isAfter(day) &&
        !dateOnly(term.endsOn).isBefore(day))
      return term;
  }
  for (final term in ordered) {
    if (dateOnly(term.startsOn).isAfter(day)) return term;
  }
  return ordered.last;
}

/// [value]'s calendar day at local midnight.
DateTime dateOnly(DateTime value) =>
    DateTime(value.year, value.month, value.day);

/// `YYYY-MM-DD` — the date-only shape every attendance endpoint expects for `session_date`.
String ymd(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-'
    '${date.month.toString().padLeft(2, '0')}-'
    '${date.day.toString().padLeft(2, '0')}';

/// Everything the Register screen renders for one class on one date.
class OfficeRegister {
  const OfficeRegister({
    required this.rosterStudentIds,
    required this.session,
    required this.records,
  });

  /// Actively enrolled students, sorted by display name.
  final List<String> rosterStudentIds;

  /// The daily session, or null when nobody has started the register yet.
  final AttendanceSession? session;

  /// What is already recorded on [session] — by the office, or by a teacher on mobile.
  final List<AttendanceRecord> records;

  bool get isSubmitted => session != null && isSubmittedSession(session!);

  Map<String, AttendanceRecord> get recordByStudent => {
    for (final record in records) record.studentId: record,
  };

  /// Roster students with no record yet — the only ones a submit sends. The batch endpoint would
  /// skip the others anyway, so they are shown as recorded rather than offered for editing.
  List<String> get toMark {
    final recorded = recordByStudent;
    return [
      for (final id in rosterStudentIds)
        if (!recorded.containsKey(id)) id,
    ];
  }
}

/// One student's pending mark on the office register. Unlike the teacher's tap-cycle
/// [AttendanceMark], minutes-late is free text so "late" starts empty and must be filled in.
class OfficeMark {
  const OfficeMark({
    this.status = AttendanceMarkStatus.present,
    this.minutesLateText = '',
  });

  final AttendanceMarkStatus status;
  final String minutesLateText;

  static const present = OfficeMark();

  /// The parsed minutes-late, or null when blank or not a number.
  int? get minutesLate => int.tryParse(minutesLateText.trim());

  /// False only for a `late` mark without a whole number of minutes `>= 1` — the API's rule.
  bool get isValid =>
      status != AttendanceMarkStatus.late ||
      (minutesLate ?? 0) >= kMinMinutesLate;

  OfficeMark copyWith({
    AttendanceMarkStatus? status,
    String? minutesLateText,
  }) => OfficeMark(
    status: status ?? this.status,
    minutesLateText: minutesLateText ?? this.minutesLateText,
  );

  /// As the shared [AttendanceMark], for [AttendanceTally].
  AttendanceMark toAttendanceMark(String studentId) => AttendanceMark(
    studentId: studentId,
    status: status,
    minutesLate: status == AttendanceMarkStatus.late ? minutesLate : null,
  );
}

/// One entry of a `POST /api/attendance/records/batch` body.
class OfficeBatchItem {
  const OfficeBatchItem({
    required this.studentId,
    required this.status,
    this.minutesLate,
  });

  final String studentId;
  final AttendanceMarkStatus status;
  final int? minutesLate;

  factory OfficeBatchItem.fromMark(String studentId, OfficeMark mark) =>
      OfficeBatchItem(
        studentId: studentId,
        status: mark.status,
        minutesLate: mark.status == AttendanceMarkStatus.late
            ? mark.minutesLate
            : null,
      );

  Map<String, Object?> toJson() => {
    'student_id': studentId,
    'status': status.wireStatus.json,
    if (minutesLate != null) 'minutes_late': minutesLate,
  };
}
