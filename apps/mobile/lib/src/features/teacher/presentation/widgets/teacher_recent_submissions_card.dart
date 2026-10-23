import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/localization/relative_time.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/teacher_providers.dart';
import '../../domain/teacher_home.dart';
import '../assignment_submissions_screen.dart';
import '../submission_marking_screen.dart';
import 'teacher_section_card.dart';

/// The most recently turned-in submissions still awaiting a mark, newest first.
class TeacherRecentSubmissionsCard extends ConsumerWidget {
  const TeacherRecentSubmissionsCard({super.key});

  static const _maxRows = 5;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pending = ref.watch(teacherPendingSubmissionsProvider);

    return TeacherSectionCard(
      titleKey: 'teacher.home.recent.title',
      icon: Icons.inbox_outlined,
      child: pending.when(
        loading: () => const TeacherCardSkeleton(),
        error: (error, stackTrace) => const TeacherCardMessage(
          messageKey: 'teacher.home.recent.error',
          icon: Icons.error_outline,
        ),
        data: (list) {
          if (list.isEmpty) {
            return const TeacherCardMessage(
              messageKey: 'teacher.home.recent.empty',
              icon: Icons.inbox_outlined,
            );
          }
          return Column(
            children: [
              for (final entry in list.take(_maxRows))
                _SubmissionRow(pending: entry),
            ],
          );
        },
      ),
    );
  }
}

class _SubmissionRow extends ConsumerWidget {
  const _SubmissionRow({required this.pending});

  final PendingSubmission pending;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final studentId = pending.submission.studentId;
    final name =
        ref.watch(rosterStudentNameProvider(studentId)) ??
        'teacher.class.unknownStudent'.tr(
          namedArgs: {'id': shortStudentId(studentId)},
        );

    return InkWell(
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => SubmissionMarkingScreen(
            assignment: pending.assignment,
            submissionId: pending.submission.id,
            studentName: name,
          ),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    pending.assignment.title,
                    style: textTheme.bodyMedium,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    relativeTimeLabel(pending.submittedAt),
                    style: textTheme.bodySmall?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            if (pending.submission.isLate) ...[
              const SizedBox(width: AppSpacing.space8),
              Text(
                'teacher.home.recent.late'.tr(),
                style: textTheme.labelSmall?.copyWith(color: colorScheme.error),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
