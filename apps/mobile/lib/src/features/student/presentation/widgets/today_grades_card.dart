import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/published_grade.dart';
import '../../../../core/offline/staleness_banner.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/today_providers.dart';
import '../../domain/today_section.dart';
import '../grades_screen.dart';
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
      accent: AppAccent.emerald,
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
        Align(
          alignment: AlignmentDirectional.centerEnd,
          child: TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const GradesScreen()),
            ),
            child: Text('grades.viewAll'.tr()),
          ),
        ),
      ],
    );
  }
}

class _GradeRow extends StatelessWidget {
  const _GradeRow({required this.grade});

  final PublishedGrade grade;

  @override
  Widget build(BuildContext context) {
    final score = grade.score;
    final visual = SubjectVisuals.of(grade.course.name, fallbackKey: grade.course.id);

    return AppIconListTile(
      icon: visual.icon,
      accent: visual.accent,
      title: grade.course.name,
      subtitle: grade.label,
      trailing: AppStatusPill(
        label: score == null ? '—' : '$score/${grade.maxScore}',
        tone: score == null ? AppTone.neutral : AppTone.forPercentage(grade.percentage),
      ),
    );
  }
}
