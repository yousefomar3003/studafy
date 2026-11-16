import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/kit/kit.dart';
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
      accent: AppAccent.amber,
      trailing: pending.maybeWhen(
        data: (list) => list.isEmpty ? null : _CountBadge(count: list.length),
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
            'teacher.home.grading.count'.tr(
              namedArgs: {'count': '${list.length}'},
            ),
            style: textTheme.bodyLarge?.copyWith(
              color: colorScheme.onSurface,
              fontWeight: FontWeight.w500,
            ),
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
    return AppStatusPill(label: '$count', tone: AppTone.warning);
  }
}
