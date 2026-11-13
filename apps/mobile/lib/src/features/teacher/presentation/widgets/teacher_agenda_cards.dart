import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
              InkWell(
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        AssignmentSubmissionsScreen(assignment: assignment),
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: AppSpacing.space8,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          assignment.title,
                          style: textTheme.bodyMedium,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: AppSpacing.space8),
                      Text(
                        'teacher.home.openWork.due'.tr(
                          namedArgs: {
                            'date': DateFormat.MMMd(
                              locale,
                            ).add_jm().format(assignment.dueAt.toLocal()),
                          },
                        ),
                        style: textTheme.bodySmall?.copyWith(
                          color: colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            if (drafts.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.space8),
              Text(
                'teacher.home.openWork.drafts'.tr(
                  namedArgs: {'count': '${drafts.length}'},
                ),
                style: textTheme.bodySmall?.copyWith(
                  color: colorScheme.onSurfaceVariant,
                ),
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
                Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: AppSpacing.space8,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              entry.exam.title,
                              style: textTheme.bodyMedium,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            Text(
                              entry.classCode,
                              style: textTheme.bodySmall?.copyWith(
                                color: colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Text(
                        DateFormat.MMMd(
                          locale,
                        ).add_jm().format(entry.exam.startsAt.toLocal()),
                        style: textTheme.bodySmall?.copyWith(
                          color: colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}
