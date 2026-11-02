import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/cumulative_grade_summary.dart';
import '../../../../core/api/generated/models/published_term_summary.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// The four headline numbers for the selected term: term average, term GPA, credits, and the
/// cumulative GPA through this term. Read straight off the published-grades snapshot — every
/// value can be null when the term summary hasn't been materialised yet, and renders as "—"
/// rather than a fabricated zero.
class TermGradeSummaryCard extends StatelessWidget {
  const TermGradeSummaryCard({
    required this.termSummary,
    required this.cumulativeSummary,
    super.key,
  });

  final PublishedTermSummary termSummary;
  final CumulativeGradeSummary cumulativeSummary;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.insights_outlined, size: 20, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Text('grades.termSummary.title'.tr(), style: textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: AppSpacing.space16),
            Wrap(
              spacing: AppSpacing.space24,
              runSpacing: AppSpacing.space16,
              children: [
                _Stat(
                  label: 'grades.termSummary.average'.tr(),
                  value: _percent(termSummary.termAveragePercentage),
                ),
                _Stat(
                  label: 'grades.termSummary.gpa'.tr(),
                  value: _decimal(termSummary.termGpa),
                ),
                _Stat(
                  label: 'grades.termSummary.credits'.tr(),
                  value: _decimal(termSummary.totalCredits),
                ),
                _Stat(
                  label: 'grades.termSummary.cumulativeGpa'.tr(),
                  value: _decimal(cumulativeSummary.cumulativeGpa),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  static String _percent(num? value) => value == null ? '—' : '${_trim(value)}%';

  static String _decimal(num? value) => value == null ? '—' : _trim(value);

  /// Up to two decimals, trailing zeros dropped — "3.5", "92", "17.25".
  static String _trim(num value) {
    final fixed = value.toDouble().toStringAsFixed(2);
    return fixed.contains('.') ? fixed.replaceFirst(RegExp(r'\.?0+$'), '') : fixed;
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: textTheme.labelMedium?.copyWith(color: colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: AppSpacing.space4),
        Text(
          value,
          style: textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
        ),
      ],
    );
  }
}
