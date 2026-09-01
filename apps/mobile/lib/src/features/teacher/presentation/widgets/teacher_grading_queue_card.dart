import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/teacher_providers.dart';
import 'teacher_section_card.dart';

/// How many turned-in submissions across the teacher's assignments are still waiting for a mark.
class TeacherGradingQueueCard extends ConsumerWidget {
  const TeacherGradingQueueCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pending = ref.watch(teacherPendingSubmissionsProvider);
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return TeacherSectionCard(
      titleKey: 'teacher.home.grading.title',
      icon: Icons.rate_review_outlined,
      trailing: pending.maybeWhen(
        data: (list) => list.isEmpty
            ? null
            : _CountBadge(count: list.length),
        orElse: () => null,
      ),
      child: pending.when(
        loading: () => const TeacherCardSkeleton(lineCount: 1),
        error: (error, stackTrace) => const TeacherCardMessage(
          messageKey: 'teacher.home.grading.error',
          icon: Icons.error_outline,
        ),
        data: (list) {
          if (list.isEmpty) {
            return const TeacherCardMessage(
              messageKey: 'teacher.home.grading.empty',
              icon: Icons.check_circle_outline,
            );
          }
          return Text(
            'teacher.home.grading.count'.tr(namedArgs: {'count': '${list.length}'}),
            style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
          );
        },
      ),
    );
  }
}

class _CountBadge extends StatelessWidget {
  const _CountBadge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space8,
        vertical: AppSpacing.space4,
      ),
      decoration: BoxDecoration(
        color: colorScheme.primaryContainer,
        borderRadius: BorderRadius.circular(9999),
      ),
      child: Text(
        '$count',
        style: textTheme.labelMedium?.copyWith(color: colorScheme.onPrimaryContainer),
      ),
    );
  }
}
