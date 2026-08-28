import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/published_grade.dart';
import '../../../../core/offline/staleness_banner.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/today_providers.dart';
import '../../domain/today_section.dart';
import 'today_card_shell.dart';
import 'today_skeleton.dart';
import 'today_state_message.dart';

/// Newly published grades for the current term, newest first. Updates live while the screen is
/// open — see [todayGradesProvider]'s doc comment.
class TodayGradesCard extends ConsumerWidget {
  const TodayGradesCard({this.maxItems = 3, super.key});

  final int maxItems;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final section = ref.watch(todayGradesProvider);

    return TodayCardShell(
      titleKey: 'today.grades.title',
      icon: Icons.grade_outlined,
      child: section.when(
        loading: () => const TodaySkeleton(),
        error: (error, stackTrace) =>
            const TodayStateMessage(messageKey: 'today.grades.error', icon: Icons.error_outline),
        data: (section) => switch (section) {
          TodaySectionUnavailable() => const TodayStateMessage(
            messageKey: 'today.grades.unavailable',
            icon: Icons.info_outline,
          ),
          TodaySectionReady(value: final cached) => _GradesContent(
            grades: cached.data.grades,
            isStale: cached.isStale,
            fetchedAt: cached.fetchedAt,
            maxItems: maxItems,
          ),
        },
      ),
    );
  }
}

class _GradesContent extends StatelessWidget {
  const _GradesContent({
    required this.grades,
    required this.isStale,
    required this.fetchedAt,
    required this.maxItems,
  });

  final List<PublishedGrade> grades;
  final bool isStale;
  final DateTime fetchedAt;
  final int maxItems;

  @override
  Widget build(BuildContext context) {
    if (grades.isEmpty) {
      return const TodayStateMessage(
        messageKey: 'today.grades.empty',
        icon: Icons.check_circle_outline,
      );
    }

    final newest = [...grades]..sort((a, b) => b.publishedAt.compareTo(a.publishedAt));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (isStale) ...[
          StalenessBanner(fetchedAt: fetchedAt),
          const SizedBox(height: AppSpacing.space12),
        ],
        for (final grade in newest.take(maxItems)) _GradeRow(grade: grade),
      ],
    );
  }
}

class _GradeRow extends StatelessWidget {
  const _GradeRow({required this.grade});

  final PublishedGrade grade;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final score = grade.score;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  grade.course.name,
                  style: textTheme.bodyMedium,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  grade.label,
                  style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          Text(
            score == null ? '—' : '$score/${grade.maxScore}',
            style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}
