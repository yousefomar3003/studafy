import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/child_comparison_item.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import 'parent_section_card.dart';

/// The selected child's latest term grades: term-average percentage and GPA as stat tiles, and —
/// when the trend carries two comparable term averages — the point change from the previous term
/// as a tinted pill.
class ChildGradesCard extends StatelessWidget {
  const ChildGradesCard({required this.child, super.key});

  final ChildComparisonItem child;

  @override
  Widget build(BuildContext context) {
    final grade = child.grade;
    final average = grade.termAveragePercentage;
    final gpa = grade.termGpa;

    if (average == null && gpa == null) {
      return const ParentSectionCard(
        titleKey: 'parent.grades.title',
        icon: Icons.school_outlined,
        accent: AppAccent.blue,
        child: ParentCardMessage(
          messageKey: 'parent.grades.empty',
          icon: Icons.info_outline,
        ),
      );
    }

    final tiles = [
      if (average != null)
        AppStatTile(
          value: '${average.round()}%',
          label: 'parent.grades.termAverage'.tr(),
          icon: Icons.percent,
          accent: AppAccent.blue,
        ),
      if (gpa != null)
        AppStatTile(
          value: gpa.toStringAsFixed(2),
          label: 'parent.grades.gpa'.tr(),
          icon: Icons.star_outline_rounded,
          accent: AppAccent.violet,
        ),
    ];

    return ParentSectionCard(
      titleKey: 'parent.grades.title',
      icon: Icons.school_outlined,
      accent: AppAccent.blue,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < tiles.length; i++) ...[
                if (i > 0) const SizedBox(width: AppSpacing.space12),
                Expanded(child: tiles[i]),
              ],
            ],
          ),
          if (_trend() case final trend?) ...[
            const SizedBox(height: AppSpacing.space12),
            AppStatusPill(label: trend.label, tone: trend.tone, icon: trend.icon),
          ],
        ],
      ),
    );
  }

  /// The previous-term comparison, or null when the trend has fewer than two terms with a
  /// recorded average.
  ({String label, AppTone tone, IconData icon})? _trend() {
    final averaged = [
      for (final point in child.gradeTrend)
        if (point.termAveragePercentage != null) point.termAveragePercentage!,
    ];
    if (averaged.length < 2) return null;

    final delta = (averaged.last - averaged[averaged.length - 2]).round();
    if (delta > 0) {
      return (
        label: 'parent.grades.trendUp'.tr(namedArgs: {'points': delta.toString()}),
        tone: AppTone.success,
        icon: Icons.trending_up,
      );
    }
    if (delta < 0) {
      return (
        label: 'parent.grades.trendDown'.tr(namedArgs: {'points': (-delta).toString()}),
        tone: AppTone.danger,
        icon: Icons.trending_down,
      );
    }
    return (
      label: 'parent.grades.trendFlat'.tr(),
      tone: AppTone.neutral,
      icon: Icons.trending_flat,
    );
  }
}
