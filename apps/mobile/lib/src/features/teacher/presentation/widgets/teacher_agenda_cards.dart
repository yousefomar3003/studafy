import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/teacher_agenda_providers.dart';
import '../assignment_submissions_screen.dart';
import 'teacher_section_card.dart';

/// Published assignments still taking hand-ins, soonest due first, each opening its submissions;
/// plus how many drafts are waiting to be published.
class TeacherOpenWorkCard extends ConsumerWidget {
  const TeacherOpenWorkCard({super.key});

  static const _maxRows = 5;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final open = ref.watch(teacherOpenWorkProvider);
    final drafts = ref.watch(teacherDraftAssignmentsProvider).value ?? const [];
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final locale = context.locale.toString();

    return TeacherSectionCard(
      titleKey: 'teacher.home.openWork.title',
      icon: Icons.assignment_outlined,
      accent: AppAccent.teal,
      child: open.when(
        loading: () => const TeacherCardSkeleton(),
        error: (error, stackTrace) => const TeacherCardMessage(
          messageKey: 'teacher.home.openWork.error',
          icon: Icons.error_outline,
        ),
        data: (list) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (list.isEmpty)
              const TeacherCardMessage(
                messageKey: 'teacher.home.openWork.empty',
                icon: Icons.check_circle_outline,
              ),
            for (final assignment in list.take(_maxRows))
              AppIconListTile(
                icon: Icons.assignment_outlined,
                accent: AppAccent.teal,
                title: assignment.title,
                subtitle: 'teacher.home.openWork.due'.tr(
                  namedArgs: {
                    'date': DateFormat.MMMd(
                      locale,
                    ).add_jm().format(assignment.dueAt.toLocal()),
                  },
                ),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        AssignmentSubmissionsScreen(assignment: assignment),
                  ),
                ),
              ),
            if (drafts.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.space8),
              Row(
                children: [
                  Icon(
                    Icons.edit_note,
                    size: 20,
                    color: colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: AppSpacing.space8),
                  Expanded(
                    child: Text(
                      'teacher.home.openWork.drafts'.tr(
                        namedArgs: {'count': '${drafts.length}'},
                      ),
                      style: textTheme.bodySmall?.copyWith(
                        color: colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Exams in the teacher's classes over the next [upcomingExamsWindow], soonest first.
class TeacherUpcomingExamsCard extends ConsumerWidget {
  const TeacherUpcomingExamsCard({super.key});

  static const _maxRows = 5;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final exams = ref.watch(teacherUpcomingExamsProvider);
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final locale = context.locale.toString();

    return TeacherSectionCard(
      titleKey: 'teacher.home.exams.title',
      icon: Icons.event_note_outlined,
      accent: AppAccent.rose,
      child: exams.when(
        loading: () => const TeacherCardSkeleton(),
        error: (error, stackTrace) => const TeacherCardMessage(
          messageKey: 'teacher.home.exams.error',
          icon: Icons.error_outline,
        ),
        data: (list) {
          if (list.isEmpty) {
            return const TeacherCardMessage(
              messageKey: 'teacher.home.exams.empty',
              icon: Icons.event_available_outlined,
            );
          }
          return Column(
            children: [
              for (final entry in list.take(_maxRows))
                AppIconListTile(
                  leading: _DateBlock(
                    date: entry.exam.startsAt.toLocal(),
                    accent: SubjectVisuals.of(entry.classCode).accent,
                  ),
                  title: entry.exam.title,
                  subtitle: entry.classCode,
                  // The date block carries the day; the time sits at the end.
                  trailing: Text(
                    DateFormat.jm(
                      locale,
                    ).format(entry.exam.startsAt.toLocal()),
                    style: textTheme.bodySmall?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

/// A small calendar leaf — month over day — in the class's accent, leading an exam row.
class _DateBlock extends StatelessWidget {
  const _DateBlock({required this.date, required this.accent});

  final DateTime date;
  final AppAccent accent;

  @override
  Widget build(BuildContext context) {
    final colors = accent.colorsOf(context);
    final textTheme = Theme.of(context).textTheme;
    final locale = context.locale.toString();

    return Semantics(
      label: DateFormat.MMMMd(locale).format(date),
      excludeSemantics: true,
      child: Container(
        width: 40,
        height: 44,
        decoration: BoxDecoration(
          color: colors.container,
          borderRadius: BorderRadius.circular(12),
        ),
        alignment: Alignment.center,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              DateFormat.MMM(locale).format(date),
              maxLines: 1,
              style: textTheme.labelSmall?.copyWith(
                color: colors.onContainer,
                fontWeight: FontWeight.w600,
                height: 1.1,
              ),
            ),
            Text(
              DateFormat.d(locale).format(date),
              style: textTheme.titleMedium?.copyWith(
                color: colors.onContainer,
                fontWeight: FontWeight.w700,
                height: 1.1,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
