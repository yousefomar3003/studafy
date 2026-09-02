import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/child_comparison_item.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import 'parent_section_card.dart';

/// The selected child's latest term grades: term-average percentage, GPA, and — when the trend
/// carries two comparable term averages — the point change from the previous term.
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
        child: ParentCardMessage(
          messageKey: 'parent.grades.empty',
          icon: Icons.info_outline,
        ),
      );
    }

    final textTheme = Theme.of(context).textTheme;

    return ParentSectionCard(
      titleKey: 'parent.grades.title',
      icon: Icons.school_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (average != null)
            _MetricRow(
              label: 'parent.grades.termAverage'.tr(),
              value: '${average.round()}%',
            ),
          if (gpa != null)
            _MetricRow(
              label: 'parent.grades.gpa'.tr(),
              value: gpa.toStringAsFixed(2),
            ),
          if (_trendLabel(context) case final label?) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              label,
              style: textTheme.bodySmall
                  ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
            ),
          ],
        ],
      ),
    );
  }

  /// The previous-term comparison line, or null when the trend has fewer than two terms with a
  /// recorded average.
  String? _trendLabel(BuildContext context) {
    final averaged = [
      for (final point in child.gradeTrend)
        if (point.termAveragePercentage != null) point.termAveragePercentage!,
    ];
    if (averaged.length < 2) return null;

    final delta = (averaged.last - averaged[averaged.length - 2]).round();
    if (delta > 0) {
      return 'parent.grades.trendUp'.tr(namedArgs: {'points': delta.toString()});
    }
    if (delta < 0) {
      return 'parent.grades.trendDown'.tr(namedArgs: {'points': (-delta).toString()});
    }
    return 'parent.grades.trendFlat'.tr();
  }
}

class _MetricRow extends StatelessWidget {
  const _MetricRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        children: [
          Expanded(child: Text(label, style: textTheme.bodyMedium)),
          Text(
            value,
            style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}
