import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/application/material_weeks_providers.dart';
import '../../../student/domain/material_weeks.dart';
import '../../../student/presentation/widgets/material_week_sections.dart';

/// The week value the editor's picker uses for "Unscheduled" (no week, no day). Never sent: the
/// editor turns it into a null pair.
const unscheduledMaterialWeek = 0;

/// The week and day of the term a material is listed under, as two dropdowns.
///
/// Weeks run from 1 to the term's length, each labelled with its teaching-day range
/// ("Week 3 · 12–16 Oct"), the current one marked; days are the school's teaching days in the
/// school's order, labelled with their date in the chosen week. When the term or the teaching
/// week can't be read the picker still works, offering weeks up to [maxMaterialWeeks] and all
/// seven days.
///
/// The upload form requires both ([required]); the edit form adds an "Unscheduled" week option
/// ([allowUnscheduled], reported as [unscheduledMaterialWeek]) so a material can be taken out of
/// the weeks again, and so one uploaded before weeks existed can be saved as it is.
class MaterialPlacementFields extends ConsumerWidget {
  const MaterialPlacementFields({
    required this.classId,
    required this.week,
    required this.day,
    required this.onWeekChanged,
    required this.onDayChanged,
    this.required = true,
    this.allowUnscheduled = false,
    this.enabled = true,
    super.key,
  });

  final String classId;

  /// The chosen week, [unscheduledMaterialWeek], or null for nothing chosen yet.
  final int? week;
  final int? day;
  final ValueChanged<int?> onWeekChanged;
  final ValueChanged<int?> onDayChanged;
  final bool required;
  final bool allowUnscheduled;
  final bool enabled;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final locale = context.locale.toString();
    final calendar =
        ref.watch(materialWeekCalendarProvider(classId)).value ?? MaterialWeekCalendar();
    final currentWeek = calendar.weekNumberOn(ref.watch(materialWeeksClockProvider)());
    final weekCount = calendar.weekCount ?? maxMaterialWeeks;
    final chosenWeek = week;
    final placed = chosenWeek != null && chosenWeek != unscheduledMaterialWeek;

    final weeks = [
      for (var w = 1; w <= weekCount; w++) w,
      // A material placed past the term's end (the term was shortened) keeps its week selectable.
      if (placed && chosenWeek > weekCount) chosenWeek,
    ];
    final days = [
      ...calendar.teachingDays,
      // Likewise a day the school no longer teaches on.
      if (day case final d? when !calendar.teachingDays.contains(d)) d,
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DropdownButtonFormField<int>(
          key: const ValueKey('material-week-field'),
          initialValue: week,
          isExpanded: true,
          decoration: InputDecoration(labelText: 'teacher.content.materialForm.week'.tr()),
          items: [
            if (allowUnscheduled)
              DropdownMenuItem(
                value: unscheduledMaterialWeek,
                child: Text('materials.weeks.unscheduled'.tr()),
              ),
            for (final w in weeks)
              DropdownMenuItem(
                value: w,
                child: Text(
                  w == currentWeek
                      ? '${materialWeekLabel(w, calendar, locale)} (${'materials.weeks.thisWeek'.tr()})'
                      : materialWeekLabel(w, calendar, locale),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
          onChanged: enabled ? onWeekChanged : null,
          validator: (value) =>
              required && value == null ? 'teacher.content.materialForm.weekRequired'.tr() : null,
        ),
        if (chosenWeek != unscheduledMaterialWeek) ...[
          const SizedBox(height: AppSpacing.space12),
          DropdownButtonFormField<int>(
            // Rebuilt per week so each day's date label follows the chosen week.
            key: ValueKey('material-day-field-$chosenWeek'),
            initialValue: day,
            isExpanded: true,
            decoration: InputDecoration(labelText: 'teacher.content.materialForm.day'.tr()),
            items: [
              for (final d in days)
                DropdownMenuItem(
                  value: d,
                  child: Text(
                    materialDayLabel(d, placed ? calendar.dateOf(chosenWeek, d) : null, locale),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
            onChanged: enabled ? onDayChanged : null,
            validator: (value) => (required || placed) && value == null
                ? 'teacher.content.materialForm.dayRequired'.tr()
                : null,
          ),
        ],
      ],
    );
  }
}
