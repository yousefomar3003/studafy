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
  const WeeklySchedule({
    required this.days,
    required this.slotsByDay,
    this.section,
    this.sections = const [],
    this.sectionFilter,
  });

  /// The days to show, in display order — every school day (lessons or not), then any other
  /// weekday that still carries a lesson.
  final List<int> days;

  /// Each day's lessons, ascending by period. Days without lessons are absent.
  final Map<int, List<TimetableSlot>> slotsByDay;

  /// The grade section the viewer's own lessons belong to ("Grade 10 · Section C"), shown as the
  /// student's timetable header — see [predominantSection]. Null when none of their lessons
  /// carries a section, or for a teacher (who teaches across sections).
  final ScheduleSection? section;

  /// Every distinct section among the viewer's lessons *before* [sectionFilter] narrowed them,
  /// in [compareScheduleSections] order — the teacher's section filter choices.
  final List<ScheduleSection> sections;

  /// The section id [slotsByDay] is narrowed to, or null for every section. Always one of
  /// [sections] when set (see [resolveSectionFilter]).
  final String? sectionFilter;

  List<TimetableSlot> slotsFor(int weekday) => slotsByDay[weekday] ?? const [];

  /// Total lessons a week.
  int get lessonCount => slotsByDay.values.fold(0, (sum, slots) => sum + slots.length);

  bool get isEmpty => lessonCount == 0;
}

/// A lesson's display labels when its source already resolved them (the parent view of a
/// child's timetable), so the lesson card needn't look any of them up: the card [title] (course
/// name, else class code), the class / section [classCode], and the optional [teacher] name.
typedef LessonLabels = ({String title, String classCode, String? teacher});

/// A grade section a lesson's class belongs to — "Section C" of "Grade 10" — read off the slot's
/// denormalized `section_*` / `grade_level_name` columns. Identity is the section id alone: the
/// names are display labels.
class ScheduleSection {
  const ScheduleSection({required this.id, required this.sectionName, this.gradeLevelName});

  final String id;

  /// The section's own name ("C").
  final String sectionName;

  /// The grade the section belongs to ("Grade 10"), or null when the API didn't label it.
  final String? gradeLevelName;

  @override
  bool operator ==(Object other) => other is ScheduleSection && other.id == id;

  @override
  int get hashCode => id.hashCode;

  @override
  String toString() => 'ScheduleSection($id, $gradeLevelName, $sectionName)';
}

/// [slot]'s section, or null when its class has none — including a slot cached before sections
/// existed (no `section_*` keys at all) and one whose section has no usable name.
ScheduleSection? scheduleSectionOf(TimetableSlot slot) {
  final id = slot.sectionId;
  final name = slot.sectionName?.trim();
  if (id == null || name == null || name.isEmpty) return null;
  final grade = slot.gradeLevelName?.trim();
  return ScheduleSection(
    id: id,
    sectionName: name,
    gradeLevelName: grade == null || grade.isEmpty ? null : grade,
  );
}

/// Display order for sections: by grade, then by section name, each compared naturally so
/// "Grade 9" sorts before "Grade 10". An unlabelled grade sorts last; the id breaks exact ties.
int compareScheduleSections(ScheduleSection a, ScheduleSection b) {
  final aGrade = a.gradeLevelName;
  final bGrade = b.gradeLevelName;
  if (aGrade != bGrade) {
    if (aGrade == null) return 1;
    if (bGrade == null) return -1;
    final byGrade = _compareNatural(aGrade, bGrade);
    if (byGrade != 0) return byGrade;
  }
  final byName = _compareNatural(a.sectionName, b.sectionName);
  return byName != 0 ? byName : a.id.compareTo(b.id);
}

/// The distinct sections among [slots], in [compareScheduleSections] order. Slots without a
/// section contribute nothing.
List<ScheduleSection> scheduleSections(Iterable<TimetableSlot> slots) {
  final sections = <ScheduleSection>{
    for (final slot in slots) ?scheduleSectionOf(slot),
  }.toList()..sort(compareScheduleSections);
  return sections;
}

/// The section most of [slots] belong to — a student's own grade section. Students are placed in
/// one section and auto-enrolled into its classes, but may also take a class of another section
/// (an elective, a cross-section group), so the section is the one carrying the most lessons.
/// Ties go to the first in [compareScheduleSections] order, so the header never flips between
/// rebuilds. Null when no slot has a section.
ScheduleSection? predominantSection(Iterable<TimetableSlot> slots) {
  final counts = <ScheduleSection, int>{};
  for (final slot in slots) {
    final section = scheduleSectionOf(slot);
    if (section != null) counts[section] = (counts[section] ?? 0) + 1;
  }
  if (counts.isEmpty) return null;
  final ranked = counts.keys.toList()
    ..sort((a, b) {
      final byCount = counts[b]!.compareTo(counts[a]!);
      return byCount != 0 ? byCount : compareScheduleSections(a, b);
    });
  return ranked.first;
}

/// [requested] when it is one of [sections], else null (every section) — so a filter whose section
/// left the schedule (a re-approved timetable, another teacher's sign-in) never strands the
/// viewer on an empty week.
String? resolveSectionFilter(List<ScheduleSection> sections, String? requested) {
  if (requested == null) return null;
  return sections.any((section) => section.id == requested) ? requested : null;
}

/// The slots of section [sectionId], or every slot when it is null.
List<TimetableSlot> slotsForSection(Iterable<TimetableSlot> slots, String? sectionId) {
  return [
    for (final slot in slots)
      if (sectionId == null || slot.sectionId == sectionId) slot,
  ];
}

/// Compares [a] and [b] case-insensitively, treating each run of digits as one number.
int _compareNatural(String a, String b) {
  final digits = RegExp(r'\d+|\D+');
  final aParts = digits.allMatches(a.toLowerCase()).map((m) => m[0]!).toList();
  final bParts = digits.allMatches(b.toLowerCase()).map((m) => m[0]!).toList();
  for (var i = 0; i < aParts.length && i < bParts.length; i++) {
    final aNumber = int.tryParse(aParts[i]);
    final bNumber = int.tryParse(bParts[i]);
    final result = aNumber != null && bNumber != null
        ? aNumber.compareTo(bNumber)
        : aParts[i].compareTo(bParts[i]);
    if (result != 0) return result;
  }
  return aParts.length.compareTo(bParts.length);
}

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
///
/// [section], [sections] and [sectionFilter] are carried through as-is (see [WeeklySchedule]);
/// [slots] must already be narrowed to [sectionFilter].
WeeklySchedule buildWeeklySchedule({
  required List<int>? schoolDays,
  required Iterable<TimetableSlot> slots,
  ScheduleSection? section,
  List<ScheduleSection> sections = const [],
  String? sectionFilter,
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

  return WeeklySchedule(
    days: [...days, ...extraDays],
    slotsByDay: slotsByDay,
    section: section,
    sections: sections,
    sectionFilter: sectionFilter,
  );
}
