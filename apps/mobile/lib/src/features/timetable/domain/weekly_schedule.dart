import '../../../core/api/generated/models/timetable_slot.dart';
import '../../../core/offline/cached_value.dart';

/// The school week the API falls back to when a school has never saved its own
/// (`db/migrations/000122_add_timetable_school_days.sql`): Sunday–Thursday, in display order.
const defaultSchoolDays = <int>[7, 1, 2, 3, 4];

/// Whose timetable a weekly schedule is — decides which "other party" each lesson shows: a
/// student sees who teaches the lesson, a teacher sees which class/section they are teaching.
enum ScheduleAudience { student, teacher }

/// The outcome of loading a weekly schedule once loading itself has finished — the same
/// three-state shape as `TodaySection` (`student/domain/today_section.dart`).
///
/// [WeeklyScheduleUnavailable] is a distinct non-error state: the viewer's context (enrolled
/// classes, or teacher record) is unresolved, or the current term has no approved timetable yet.
sealed class WeeklyScheduleStatus {
  const WeeklyScheduleStatus();
}

class WeeklyScheduleReady extends WeeklyScheduleStatus {
  const WeeklyScheduleReady(this.value);

  final CachedValue<WeeklySchedule> value;
}

class WeeklyScheduleUnavailable extends WeeklyScheduleStatus {
  const WeeklyScheduleUnavailable();
}

/// A school's fixed weekly schedule, narrowed to one viewer: the same every week, so it carries
/// weekdays (1 = Monday … 7 = Sunday, matching [DateTime.weekday] and the slot model) and never
/// dates.
class WeeklySchedule {
  const WeeklySchedule({required this.days, required this.slotsByDay});

  /// The days to show, in display order — every school day (lessons or not), then any other
  /// weekday that still carries a lesson.
  final List<int> days;

  /// Each day's lessons, ascending by period. Days without lessons are absent.
  final Map<int, List<TimetableSlot>> slotsByDay;

  List<TimetableSlot> slotsFor(int weekday) => slotsByDay[weekday] ?? const [];

  /// Total lessons a week.
  int get lessonCount => slotsByDay.values.fold(0, (sum, slots) => sum + slots.length);

  bool get isEmpty => lessonCount == 0;
}

/// A lesson's display labels when its source already resolved them (the parent view of a
/// child's timetable), so the lesson card needn't look any of them up: the card [title] (course
/// name, else class code), the class / section [classCode], and optional [room] / [teacher]
/// names.
typedef LessonLabels = ({String title, String classCode, String? room, String? teacher});

/// [schoolDays] cleaned for display: out-of-range weekdays and duplicates dropped, order kept.
/// Falls back to [defaultSchoolDays] when null or nothing valid is left — the same default the
/// API serves.
List<int> orderedSchoolDays(List<int>? schoolDays) {
  final seen = <int>{};
  final days = [
    for (final day in schoolDays ?? const <int>[])
      if (day >= DateTime.monday && day <= DateTime.sunday && seen.add(day)) day,
  ];
  return days.isEmpty ? defaultSchoolDays : days;
}

/// Which day a schedule opens on: [now]'s weekday when it is one of [days], else the first day.
int initialScheduleDay(List<int> days, DateTime now) {
  if (days.contains(now.weekday)) return now.weekday;
  return days.isEmpty ? now.weekday : days.first;
}

/// The slots of the classes in [classIds] — a student's view of the whole version.
List<TimetableSlot> slotsForClasses(Iterable<TimetableSlot> slots, Set<String> classIds) {
  return [
    for (final slot in slots)
      if (classIds.contains(slot.classId)) slot,
  ];
}

/// The slots [teacherId] teaches — a teacher's view of the whole version.
List<TimetableSlot> slotsForTeacher(Iterable<TimetableSlot> slots, String teacherId) {
  return [
    for (final slot in slots)
      if (slot.teacherId == teacherId) slot,
  ];
}

/// Assembles a [WeeklySchedule] from already-filtered [slots] and the school's [schoolDays].
/// Pure — no clock, no I/O.
///
/// A lesson on a weekday outside [schoolDays] (the week was narrowed after the timetable was
/// approved) is still shown, on a day appended after the school days, rather than silently
/// hidden: whatever was approved must show.
WeeklySchedule buildWeeklySchedule({
  required List<int>? schoolDays,
  required Iterable<TimetableSlot> slots,
}) {
  final slotsByDay = <int, List<TimetableSlot>>{};
  for (final slot in slots) {
    slotsByDay.putIfAbsent(slot.weekday, () => []).add(slot);
  }
  for (final daySlots in slotsByDay.values) {
    daySlots.sort((a, b) => a.period.compareTo(b.period));
  }

  final days = orderedSchoolDays(schoolDays);
  final extraDays = slotsByDay.keys.where((day) => !days.contains(day)).toList()..sort();

  return WeeklySchedule(days: [...days, ...extraDays], slotsByDay: slotsByDay);
}
