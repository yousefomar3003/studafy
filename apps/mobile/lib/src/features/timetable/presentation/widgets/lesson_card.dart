import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/timetable_slot.dart';
import '../../../../core/auth/auth_providers.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/weekly_schedule_providers.dart';
import '../../domain/weekly_schedule.dart';
import 'schedule_section.dart';

/// A class's display labels: its section code ("SCI101-A") and, when resolvable, its course's
/// name ("Integrated Science").
typedef ScheduleClassLabel = ({String code, String? courseName});

/// Resolves a class's labels by id. Riverpod's `.family` cache covers the handful of distinct
/// classes on one schedule. The course name is best-effort: if that lookup fails the card falls
/// back to the class code.
final scheduleClassLabelProvider = FutureProvider.autoDispose
    .family<ScheduleClassLabel, String>((ref, classId) async {
      final api = ref.watch(apiClientProvider);
      final classValue = await api.academics.getClass(classId: classId);
      String? courseName;
      try {
        courseName = (await api.academics.getCourse(
          courseId: classValue.courseId,
        )).name;
      } on Object {
        courseName = null;
      }
      return (code: classValue.code, courseName: courseName);
    });

/// One lesson in a weekly schedule: a period badge, the subject, and the other party — the
/// teacher for a student (when resolvable), the class code for a teacher, with the grade section
/// ("Grade 10 · Section C") on a line of its own beneath, since a teacher teaches across
/// sections. A student's section is the schedule's header instead (see `ScheduleSectionHeader`).
/// Lessons carry no room: a timetable is per grade section only.
///
/// With [labels] (a source that resolved every name already, e.g. a parent's view of a child's
/// timetable) nothing is looked up; otherwise class, course and teacher names are resolved
/// through the providers above.
class LessonCard extends ConsumerWidget {
  const LessonCard({
    required this.slot,
    required this.audience,
    this.labels,
    super.key,
  });

  final TimetableSlot slot;
  final ScheduleAudience audience;
  final LessonLabels? labels;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final resolved = labels;
    final label = resolved != null
        ? (code: resolved.classCode, courseName: resolved.title)
        : ref.watch(scheduleClassLabelProvider(slot.classId)).value;
    final teacherName = audience != ScheduleAudience.student
        ? null
        : resolved != null
        ? resolved.teacher
        : ref.watch(timetableTeacherNameProvider(slot.teacherId));

    final section = audience == ScheduleAudience.teacher
        ? scheduleSectionOf(slot)
        : null;

    final title =
        label?.courseName ?? label?.code ?? 'timetable.slot.unknownClass'.tr();
    final details = <(IconData, String)>[
      if (audience == ScheduleAudience.teacher && label != null)
        (Icons.groups_outlined, label.code),
      if (teacherName != null) (Icons.person_outline, teacherName),
    ];
    final periodLabel = 'timetable.period'.tr(
      namedArgs: {'period': '${slot.period}'},
    );

    return Card(
      child: MergeSemantics(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space12),
          child: Row(
            children: [
              Semantics(
                label: periodLabel,
                excludeSemantics: true,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: colorScheme.primaryContainer,
                    borderRadius: AppRadius.mdRadius,
                  ),
                  child: SizedBox.square(
                    dimension: 44,
                    child: Center(
                      child: Text(
                        '${slot.period}',
                        style: theme.textTheme.titleMedium?.copyWith(
                          color: colorScheme.onPrimaryContainer,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.space12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (details.isNotEmpty) ...[
                      const SizedBox(height: AppSpacing.space4),
                      Wrap(
                        spacing: AppSpacing.space12,
                        runSpacing: AppSpacing.space4,
                        children: [
                          for (final (icon, text) in details)
                            _Detail(icon: icon, text: text),
                        ],
                      ),
                    ],
                    // A teacher's lesson names the grade section it is taught to, on its own
                    // line under the class code.
                    if (section != null) ...[
                      const SizedBox(height: AppSpacing.space4),
                      _Detail(
                        icon: Icons.school_outlined,
                        text: scheduleSectionLabel(section),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Detail extends StatelessWidget {
  const _Detail({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = theme.colorScheme.onSurfaceVariant;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: AppSpacing.space4),
        Flexible(
          child: Text(
            text,
            style: theme.textTheme.bodySmall?.copyWith(color: color),
          ),
        ),
      ],
    );
  }
}
