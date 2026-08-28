import '../../../core/api/generated/models/exam.dart';
import '../../../core/api/generated/models/timetable_slot.dart';
import '../../../core/offline/cached_value.dart';

/// The outcome of loading the student timetable screen, once loading itself has finished — the
/// same three-state shape [TodaySection](`today_section.dart`) uses, for the same reason.
///
/// [TimetableWeekReady] carries a real, possibly-stale [TimetableWeek] (see [CachedValue.isStale]).
/// [TimetableWeekUnavailable] is a distinct non-error state: the screen needs the signed-in
/// student's enrolled classes (`student_context_providers.dart`'s `currentEnrolledClassIdsProvider`)
/// and an approved timetable version for the current term, and neither is a failed fetch when
/// missing — it is a known gap or a school that simply has no approved timetable yet.
sealed class TimetableWeekStatus {
  const TimetableWeekStatus();
}

class TimetableWeekReady extends TimetableWeekStatus {
  const TimetableWeekReady(this.value);

  final CachedValue<TimetableWeek> value;
}

class TimetableWeekUnavailable extends TimetableWeekStatus {
  const TimetableWeekUnavailable();
}

/// One calendar week of the approved timetable: the recurring weekly slots, plus any exams that
/// fall inside this specific week overlaid onto their day. [weekStart] is the local midnight of
/// the week's Monday (ISO 8601 week, matching [DateTime.weekday] where Monday is 1).
class TimetableWeek {
  const TimetableWeek({required this.weekStart, required this.days});

  final DateTime weekStart;

  /// Only the weekdays that actually carry something — a class or an exam — ascending by weekday.
  /// A school running Sunday–Thursday and one running Monday–Friday both fall out of the data
  /// without a hard-coded work-week here.
  final List<TimetableDay> days;

  bool get isEmpty => days.isEmpty;
}

class TimetableDay {
  const TimetableDay({
    required this.date,
    required this.weekday,
    required this.slots,
    required this.exams,
  });

  final DateTime date;

  /// 1 = Monday … 7 = Sunday, matching [DateTime.weekday].
  final int weekday;

  /// This day's periods, ascending by period number.
  final List<TimetableSlot> slots;

  /// Exams scheduled on this day within the week, ascending by start time.
  final List<Exam> exams;
}

/// An exam status that means the exam is off the calendar and should not overlay the timetable.
/// Compared by [Enum.name] rather than the generated `Status*` enum type, whose name
/// `swagger_parser` assigns by a document-wide dedup pass and so isn't safe to hard-reference;
/// every value in the spec's exam-status enum is a single lowercase word, so `.name` is exactly
/// the wire value.
const _cancelledExamStatus = 'cancelled';

/// Assembles [weekStart]'s [TimetableWeek] from the raw inputs. Pure — no clock, no I/O — so the
/// week-window and enrolment filtering is unit-testable on its own.
///
///   * Slots are the recurring weekly grid: every slot for an [enrolledClassIds] class shows on
///     every week. The caller passes the whole approved version's slots (all classes); this drops
///     the ones the student isn't enrolled in.
///   * Exams are date-specific: only those whose start falls in `[weekStart, weekStart + 7d)` and
///     that aren't [_cancelledExamStatus] overlay this week.
TimetableWeek assembleTimetableWeek({
  required DateTime weekStart,
  required List<TimetableSlot> slots,
  required List<Exam> exams,
  required Set<String> enrolledClassIds,
}) {
  final weekEnd = weekStart.add(const Duration(days: 7));

  final slotsByWeekday = <int, List<TimetableSlot>>{};
  for (final slot in slots) {
    if (!enrolledClassIds.contains(slot.classId)) continue;
    slotsByWeekday.putIfAbsent(slot.weekday, () => []).add(slot);
  }

  final examsByWeekday = <int, List<Exam>>{};
  for (final exam in exams) {
    if (exam.status.name == _cancelledExamStatus) continue;
    final startsAt = exam.startsAt.toLocal();
    if (startsAt.isBefore(weekStart) || !startsAt.isBefore(weekEnd)) continue;
    examsByWeekday.putIfAbsent(startsAt.weekday, () => []).add(exam);
  }

  final weekdays = {...slotsByWeekday.keys, ...examsByWeekday.keys}.toList()..sort();

  final days = [
    for (final weekday in weekdays)
      TimetableDay(
        date: weekStart.add(Duration(days: weekday - 1)),
        weekday: weekday,
        slots: (slotsByWeekday[weekday] ?? [])..sort((a, b) => a.period.compareTo(b.period)),
        exams: (examsByWeekday[weekday] ?? [])
          ..sort((a, b) => a.startsAt.compareTo(b.startsAt)),
      ),
  ];

  return TimetableWeek(weekStart: weekStart, days: days);
}
