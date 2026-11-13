import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/weekly_schedule.dart';

/// [section]'s display label — "Grade 10 · Section C" / "Grade 10 · الشعبة C", or just the
/// section when the grade is unlabelled.
///
/// The grade and section names are school-entered data in either script, so each is wrapped in a
/// Unicode first-strong isolate: a Latin "Grade 10" inside an Arabic sentence (or an Arabic name
/// inside an English one) keeps its own direction instead of reordering the separator around it.
String scheduleSectionLabel(ScheduleSection section) {
  final grade = section.gradeLevelName;
  final name = _isolate(section.sectionName);
  return grade == null
      ? 'timetable.section.sectionOnly'.tr(namedArgs: {'section': name})
      : 'timetable.section.gradeAndSection'.tr(
          namedArgs: {'grade': _isolate(grade), 'section': name},
        );
}

/// U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL ISOLATE.
String _isolate(String text) => '\u2068$text\u2069';

/// The student's timetable header line: which grade section the schedule is ("Grade 10 ·
/// Section C"). Read as "Grade and section: …" by screen readers.
class ScheduleSectionHeader extends StatelessWidget {
  const ScheduleSectionHeader({required this.section, super.key});

  final ScheduleSection section;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = theme.colorScheme.primary;
    final label = scheduleSectionLabel(section);

    return Semantics(
      label: 'timetable.section.semantics'.tr(namedArgs: {'label': label}),
      excludeSemantics: true,
      child: Row(
        children: [
          Icon(Icons.school_outlined, size: 18, color: color),
          const SizedBox(width: AppSpacing.space4),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: color,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The teacher's section filter: an "All" chip plus one chip per section they teach, the
/// selected one filled — the same chip row as the grades screen's term picker
/// (`student/presentation/widgets/grade_term_selector.dart`). [selected] null is "All".
class ScheduleSectionFilter extends StatelessWidget {
  const ScheduleSectionFilter({
    required this.sections,
    required this.selected,
    required this.onSelected,
    super.key,
  });

  final List<ScheduleSection> sections;
  final String? selected;
  final ValueChanged<String?> onSelected;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: 'timetable.section.filterLabel'.tr(),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16),
        child: Row(
          children: [
            _chip(label: 'timetable.section.all'.tr(), sectionId: null),
            for (final section in sections)
              _chip(label: scheduleSectionLabel(section), sectionId: section.id),
          ],
        ),
      ),
    );
  }

  Widget _chip({required String label, required String? sectionId}) {
    return Padding(
      padding: const EdgeInsetsDirectional.only(end: AppSpacing.space8),
      child: ChoiceChip(
        label: Text(label),
        selected: sectionId == selected,
        onSelected: (_) => onSelected(sectionId),
      ),
    );
  }
}
