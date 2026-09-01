import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/localization/relative_time.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/teacher_providers.dart';
import '../../domain/teacher_home.dart';
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
              for (final entry in list.take(_maxRows)) _SubmissionRow(pending: entry),
            ],
          );
        },
      ),
    );
  }
}

class _SubmissionRow extends StatelessWidget {
  const _SubmissionRow({required this.pending});

  final PendingSubmission pending;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return Padding(
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
                  style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
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
    );
  }
}
