import '../../../core/api/generated/models/material.dart';

/// All seven ISO weekdays, Monday first: the day order when the school's teaching week is unknown.
const allWeekdays = <int>[
  DateTime.monday,
  DateTime.tuesday,
  DateTime.wednesday,
  DateTime.thursday,
  DateTime.friday,
  DateTime.saturday,
  DateTime.sunday,
];

/// The most weeks a material can be placed in — the API's `week_number` bound (000226).
const maxMaterialWeeks = 60;

/// What a class's materials are placed against: its term's dates and the school's teaching week.
///
/// A material stores its week and day as plain numbers (`week_number`, `day_of_week`), never as a
/// date, so a term-date edit doesn't move it. This turns those numbers into dates for display only:
/// week 1 is the week containing [termStartsOn], and a week starts on the first of [teachingDays]
/// (the school's display order, so a Sunday-to-Thursday school's weeks start on Sunday).
///
/// Both term dates are null when the term couldn't be read (offline, say): the materials still
/// group by week, just without date ranges or a known current week.
class MaterialWeekCalendar {
  MaterialWeekCalendar({
    DateTime? termStartsOn,
    DateTime? termEndsOn,
    List<int> teachingDays = allWeekdays,
  }) : termStartsOn = termStartsOn == null ? null : _day(termStartsOn),
       termEndsOn = termEndsOn == null ? null : _day(termEndsOn),
       teachingDays = teachingDays.isEmpty ? allWeekdays : List.unmodifiable(teachingDays);

  final DateTime? termStartsOn;
  final DateTime? termEndsOn;

  /// The days a teacher can place a material on, in display order. Never empty.
  final List<int> teachingDays;

  /// The ISO weekday each week starts on.
  int get weekStartDay => teachingDays.first;

  /// How many days [weekday] falls after [weekStartDay], 0..6.
  int offsetOf(int weekday) => (weekday - weekStartDay) % 7;

  /// [days] ordered as they fall in a week starting on [weekStartDay].
  List<int> inWeekOrder(Iterable<int> days) =>
      days.toSet().toList()..sort((a, b) => offsetOf(a).compareTo(offsetOf(b)));

  /// The first day of the week [date] falls in, as a UTC calendar date.
  DateTime startOfWeek(DateTime date) {
    final day = _day(date);
    return DateTime.utc(day.year, day.month, day.day - offsetOf(day.weekday));
  }

  /// The first day of term week [week], or null when the term start is unknown.
  DateTime? weekStart(int week) {
    final start = termStartsOn;
    if (start == null) return null;
    final first = startOfWeek(start);
    return DateTime.utc(first.year, first.month, first.day + 7 * (week - 1));
  }

  /// The date of [dayOfWeek] in term week [week], or null when the term start is unknown.
  DateTime? dateOf(int week, int dayOfWeek) {
    final start = weekStart(week);
    if (start == null) return null;
    return DateTime.utc(start.year, start.month, start.day + offsetOf(dayOfWeek));
  }

  /// The first and last teaching day of term week [week], for a "12–16 Oct" label.
  (DateTime, DateTime)? teachingRange(int week) {
    final ordered = inWeekOrder(teachingDays);
    final first = dateOf(week, ordered.first);
    final last = dateOf(week, ordered.last);
    if (first == null || last == null) return null;
    return (first, last);
  }

  /// The term week [date] falls in. Zero or less before the term's first week, above [weekCount]
  /// after its last; null when the term start is unknown.
  int? weekNumberOn(DateTime date) {
    final start = termStartsOn;
    if (start == null) return null;
    final days = startOfWeek(date).difference(startOfWeek(start)).inDays;
    return (days / 7).floor() + 1;
  }

  /// How many weeks the term spans, capped to 1..[maxMaterialWeeks]; null when either date is
  /// unknown (the teacher's week picker then offers every week up to [maxMaterialWeeks]).
  int? get weekCount {
    final end = termEndsOn;
    if (end == null) return null;
    final weeks = weekNumberOn(end);
    if (weeks == null) return null;
    return weeks.clamp(1, maxMaterialWeeks);
  }

  static DateTime _day(DateTime date) => DateTime.utc(date.year, date.month, date.day);
}

/// One day's materials inside a [MaterialWeekSection], in the order the server listed them.
class MaterialDayGroup {
  const MaterialDayGroup({required this.dayOfWeek, required this.date, required this.materials});

  /// ISO weekday, 1 = Monday .. 7 = Sunday.
  final int dayOfWeek;

  /// The calendar date of this day, or null when the term start is unknown.
  final DateTime? date;
  final List<Material> materials;
}

/// One collapsible section of a class's materials: a term week with its day groups, or the final
/// "Unscheduled" section ([weekNumber] null) for materials placed in no week.
class MaterialWeekSection {
  const MaterialWeekSection({
    required this.weekNumber,
    required this.days,
    required this.unscheduled,
    this.range,
  });

  /// The term week, or null for the Unscheduled section.
  final int? weekNumber;

  /// The week's day groups in week order. Empty for the Unscheduled section.
  final List<MaterialDayGroup> days;

  /// The Unscheduled section's materials. Empty for a week section.
  final List<Material> unscheduled;

  /// The week's first and last teaching day, when the term start is known.
  final (DateTime, DateTime)? range;

  bool get isUnscheduled => weekNumber == null;

  /// Stable across reloads, for remembering whether the section is collapsed.
  String get key => weekNumber == null ? 'unscheduled' : 'week-$weekNumber';

  int get materialCount =>
      unscheduled.length + days.fold(0, (sum, day) => sum + day.materials.length);
}

/// Groups [materials] into week sections, ascending by week, each holding its day groups in
/// [calendar]'s week order, then a final Unscheduled section when any material has no week.
///
/// Only weeks that hold a material get a section. A day outside the school's teaching week (the
/// week was narrowed after the material was placed) still gets its group, in week order, so no
/// material is hidden. Within a day the input order is kept — the server's newest-first.
List<MaterialWeekSection> groupMaterialsByWeek(
  Iterable<Material> materials,
  MaterialWeekCalendar calendar,
) {
  final byWeek = <int, Map<int, List<Material>>>{};
  final unscheduled = <Material>[];
  for (final material in materials) {
    final week = material.weekNumber;
    final day = material.dayOfWeek;
    if (week == null || day == null || day < 1 || day > 7) {
      unscheduled.add(material);
      continue;
    }
    byWeek.putIfAbsent(week, () => {}).putIfAbsent(day, () => []).add(material);
  }

  final weeks = byWeek.keys.toList()..sort();
  return [
    for (final week in weeks)
      MaterialWeekSection(
        weekNumber: week,
        range: calendar.teachingRange(week),
        unscheduled: const [],
        days: [
          for (final day in calendar.inWeekOrder(byWeek[week]!.keys))
            MaterialDayGroup(
              dayOfWeek: day,
              date: calendar.dateOf(week, day),
              materials: List.unmodifiable(byWeek[week]![day]!),
            ),
        ],
      ),
    if (unscheduled.isNotEmpty)
      MaterialWeekSection(
        weekNumber: null,
        days: const [],
        unscheduled: List.unmodifiable(unscheduled),
      ),
  ];
}

/// The section that starts expanded: the current week's. When the current week holds nothing, the
/// most recent earlier week that does (what was just taught), and failing that the first section —
/// so a class whose materials are all unscheduled (everything uploaded before weeks existed) still
/// opens showing them. Null only when there are no sections.
String? defaultExpandedSectionKey(
  List<MaterialWeekSection> sections,
  MaterialWeekCalendar calendar,
  DateTime today,
) {
  if (sections.isEmpty) return null;
  final current = calendar.weekNumberOn(today);
  if (current != null) {
    MaterialWeekSection? latestPast;
    for (final section in sections) {
      final week = section.weekNumber;
      if (week == null) continue;
      if (week == current) return section.key;
      if (week < current) latestPast = section;
    }
    if (latestPast != null) return latestPast.key;
  }
  return sections.first.key;
}
