import '../../../core/api/generated/models/exam.dart';
import '../../../core/offline/cached_value.dart';

/// The outcome of loading the student exams screen, once loading itself has finished — the same
/// three-state shape [TimetableWeekStatus](`timetable_week.dart`) uses, for the same reason.
///
/// [ExamsAgendaReady] carries a real, possibly-stale [ExamsAgenda] (see [CachedValue.isStale]);
/// an empty agenda is still a ready state, and the screen renders its own "no upcoming exams"
/// body for it. [ExamsAgendaUnavailable] is the distinct non-error state: the screen needs the
/// signed-in student's enrolled classes (`student_context_providers.dart`'s
/// `currentEnrolledClassIdsProvider`), and their absence is a known missing endpoint, not a
/// failed fetch.
sealed class ExamsAgendaStatus {
  const ExamsAgendaStatus();
}

class ExamsAgendaReady extends ExamsAgendaStatus {
  const ExamsAgendaReady(this.value);

  final CachedValue<ExamsAgenda> value;
}

class ExamsAgendaUnavailable extends ExamsAgendaStatus {
  const ExamsAgendaUnavailable();
}

/// Upcoming exams for the student's enrolled classes, grouped into calendar days ascending.
class ExamsAgenda {
  const ExamsAgenda({required this.days});

  /// Only the days that carry at least one exam, ascending by date.
  final List<ExamDay> days;

  bool get isEmpty => days.isEmpty;
}

class ExamDay {
  const ExamDay({required this.date, required this.exams});

  /// Local midnight of the day.
  final DateTime date;

  /// This day's exams, ascending by start time.
  final List<Exam> exams;
}

/// Exam statuses that keep an exam off the upcoming calendar regardless of its date. Compared by
/// [Enum.name] rather than the generated `ExamStatus` enum, whose name `swagger_parser` assigns
/// by a document-wide dedup pass and so isn't safe to hard-reference — same reasoning as
/// `timetable_week.dart`'s `_cancelledExamStatus`. Every value in the spec's exam-status enum is
/// a single lowercase word, so `.name` is exactly the wire value.
const _hiddenExamStatuses = {'cancelled', 'archived'};

/// Assembles the upcoming-exams agenda from raw [exams] and a reference [now]. Pure — no clock,
/// no I/O — so the "upcoming" window and day grouping are unit-testable on their own.
///
///   * An exam is upcoming while it has not yet ended: [Exam.endsAt] at or after [now]. An exam
///     in progress right now still shows.
///   * [_hiddenExamStatuses] exams drop out entirely.
///   * The rest are grouped by the local calendar date of their start, days and exams both
///     ascending.
ExamsAgenda assembleExamsAgenda({required List<Exam> exams, required DateTime now}) {
  final examsByDate = <DateTime, List<Exam>>{};
  for (final exam in exams) {
    if (_hiddenExamStatuses.contains(exam.status.name)) continue;
    if (exam.endsAt.toLocal().isBefore(now)) continue;
    final startsAt = exam.startsAt.toLocal();
    final date = DateTime(startsAt.year, startsAt.month, startsAt.day);
    examsByDate.putIfAbsent(date, () => []).add(exam);
  }

  final dates = examsByDate.keys.toList()..sort();
  final days = [
    for (final date in dates)
      ExamDay(
        date: date,
        exams: examsByDate[date]!..sort((a, b) => a.startsAt.compareTo(b.startsAt)),
      ),
  ];

  return ExamsAgenda(days: days);
}
