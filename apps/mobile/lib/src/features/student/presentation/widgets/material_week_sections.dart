import 'dart:convert';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../../core/api/generated/models/material.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../timetable/presentation/weekly_schedule_view.dart' show weekdayName;
import '../../application/material_weeks_providers.dart';
import '../../domain/material_weeks.dart';

/// A short "12–16 Oct" (or "28 Sep – 2 Oct") label for a week's first and last teaching day.
String materialWeekRangeLabel((DateTime, DateTime) range, String locale) {
  final (first, last) = range;
  final dayMonth = DateFormat('d MMM', locale);
  if (first.year == last.year && first.month == last.month) {
    return '${DateFormat('d', locale).format(first)}–${dayMonth.format(last)}';
  }
  return '${dayMonth.format(first)} – ${dayMonth.format(last)}';
}

/// "Week 3 · 12–16 Oct", or just "Week 3" when the term dates are unknown.
String materialWeekLabel(int week, MaterialWeekCalendar calendar, String locale) {
  final title = 'materials.weeks.week'.tr(namedArgs: {'number': '$week'});
  final range = calendar.teachingRange(week);
  return range == null ? title : '$title · ${materialWeekRangeLabel(range, locale)}';
}

/// "Tuesday · 13 Oct", or just "Tuesday" when the date is unknown.
String materialDayLabel(int dayOfWeek, DateTime? date, String locale) {
  final name = weekdayName(dayOfWeek, locale);
  return date == null ? name : '$name · ${DateFormat('d MMM', locale).format(date)}';
}

/// A class's materials as collapsible week sections, each with its day sub-groups, then a final
/// Unscheduled section (see [groupMaterialsByWeek]). Shared by the student materials library and
/// the teacher's class content screen; [itemBuilder] draws each material row.
///
/// The current week starts expanded and the rest collapsed ([defaultExpandedSectionKey]). Whatever
/// the user opens or closes is remembered per class on this device, so returning to the list
/// keeps it as they left it; a week they never touched follows the default as the term moves on.
class MaterialWeekSections extends ConsumerStatefulWidget {
  const MaterialWeekSections({
    required this.classId,
    required this.materials,
    required this.itemBuilder,
    super.key,
  });

  final String classId;
  final List<Material> materials;
  final Widget Function(BuildContext context, Material material) itemBuilder;

  @override
  ConsumerState<MaterialWeekSections> createState() => _MaterialWeekSectionsState();
}

/// The SharedPreferences key holding [classId]'s open/closed sections. Not sensitive: section keys
/// ("week-3", "unscheduled") under a class id.
String materialWeekSectionsPrefsKey(String classId) => 'materials.weekSections.$classId';

/// This run's choices per class, so a list that rebuilds the sections (the teacher list shows a
/// spinner while it re-reads) doesn't flash the defaults before the stored choices load.
final _sessionChoices = <String, Map<String, bool>>{};

/// Forgets this run's choices, so the next sections read them from the device store again.
@visibleForTesting
void resetMaterialWeekSectionsSession() => _sessionChoices.clear();

class _MaterialWeekSectionsState extends ConsumerState<MaterialWeekSections> {
  /// Sections the user opened (true) or closed (false); anything absent follows the default.
  Map<String, bool> _choices = const {};

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void didUpdateWidget(MaterialWeekSections oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.classId != widget.classId) _start();
  }

  void _start() {
    final known = _sessionChoices[widget.classId];
    _choices = known ?? const {};
    if (known == null) _restore();
  }

  Future<void> _restore() async {
    final classId = widget.classId;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(materialWeekSectionsPrefsKey(classId));
      if (raw == null) return;
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return;
      final restored = {
        for (final entry in decoded.entries)
          if (entry.value is bool) entry.key: entry.value as bool,
      };
      if (!mounted || classId != widget.classId) return;
      // A tap that landed before the restore finished wins over the stored value.
      setState(() => _choices = _sessionChoices[classId] = {...restored, ..._choices});
    } on Object {
      // Remembering is a convenience; an unreadable store just means the defaults.
    }
  }

  Future<void> _persist() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(materialWeekSectionsPrefsKey(widget.classId), jsonEncode(_choices));
    } on Object {
      // As above: losing the choice costs the user one tap next time.
    }
  }

  void _toggle(String key, bool expanded) {
    setState(() => _choices = _sessionChoices[widget.classId] = {..._choices, key: expanded});
    _persist();
  }

  @override
  Widget build(BuildContext context) {
    final calendar =
        ref.watch(materialWeekCalendarProvider(widget.classId)).value ?? MaterialWeekCalendar();
    final today = ref.watch(materialWeeksClockProvider)();
    final sections = groupMaterialsByWeek(widget.materials, calendar);
    final defaultKey = defaultExpandedSectionKey(sections, calendar, today);
    final currentWeek = calendar.weekNumberOn(today);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final section in sections)
          _WeekSection(
            key: ValueKey('material-week-section-${section.key}'),
            section: section,
            calendar: calendar,
            isCurrent: section.weekNumber != null && section.weekNumber == currentWeek,
            expanded: _choices[section.key] ?? section.key == defaultKey,
            onToggle: (expanded) => _toggle(section.key, expanded),
            itemBuilder: widget.itemBuilder,
          ),
      ],
    );
  }
}

class _WeekSection extends StatelessWidget {
  const _WeekSection({
    required this.section,
    required this.calendar,
    required this.isCurrent,
    required this.expanded,
    required this.onToggle,
    required this.itemBuilder,
    super.key,
  });

  final MaterialWeekSection section;
  final MaterialWeekCalendar calendar;
  final bool isCurrent;
  final bool expanded;
  final ValueChanged<bool> onToggle;
  final Widget Function(BuildContext context, Material material) itemBuilder;

  @override
  Widget build(BuildContext context) {
    final locale = context.locale.toString();
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final week = section.weekNumber;
    final title = week == null
        ? 'materials.weeks.unscheduled'.tr()
        : materialWeekLabel(week, calendar, locale);
    final count = 'materials.weeks.count'.plural(section.materialCount);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          expanded: expanded,
          child: ListTile(
            contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.space8),
            title: Text(
              title,
              style: textTheme.titleSmall?.copyWith(color: isCurrent ? colorScheme.primary : null),
            ),
            subtitle: Text(
              isCurrent ? '${'materials.weeks.thisWeek'.tr()} · $count' : count,
              style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
            trailing: AnimatedRotation(
              turns: expanded ? 0.5 : 0,
              duration: const Duration(milliseconds: 150),
              child: const Icon(Icons.expand_more),
            ),
            onTap: () => onToggle(!expanded),
          ),
        ),
        if (expanded) ...[
          for (final material in section.unscheduled) itemBuilder(context, material),
          for (final day in section.days) ...[
            Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(
                AppSpacing.space16,
                AppSpacing.space8,
                AppSpacing.space16,
                AppSpacing.space4,
              ),
              child: Text(
                materialDayLabel(day.dayOfWeek, day.date, locale),
                style: textTheme.labelMedium?.copyWith(color: colorScheme.onSurfaceVariant),
              ),
            ),
            for (final material in day.materials) itemBuilder(context, material),
          ],
        ],
        const Divider(height: 1),
      ],
    );
  }
}
