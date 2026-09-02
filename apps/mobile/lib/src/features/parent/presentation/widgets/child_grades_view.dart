import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/grade_trend_point.dart';
import '../../../../core/api/generated/models/published_term_summary.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/presentation/widgets/subject_grades_card.dart';
import '../../application/child_detail_providers.dart';
import '../../domain/child_subject_grades.dart';
import 'child_detail_placeholders.dart';

/// The Grades tab of `ChildDetailScreen`: the child's term summary, their term-over-term average
/// trend, and one `SubjectGradesCard` per course — the same per-subject breakdown widget the
/// child sees on their own grades screen, so the numbers match exactly (acceptance criterion
/// "data parity with the child's own student views").
class ChildGradesView extends ConsumerWidget {
  const ChildGradesView({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final breakdown = ref.watch(childBreakdownProvider(studentId));

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(childBreakdownProvider(studentId)),
      child: breakdown.when(
        loading: () => const ChildDetailSkeleton(),
        error: (_, _) => const ChildDetailMessage(
          messageKey: 'parent.childDetail.error',
          icon: Icons.error_outline,
        ),
        data: (data) {
          final subjects = groupChildSubjects(data.grade.grades);
          return ListView(
            padding: const EdgeInsets.all(AppSpacing.space16),
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              _TermSummaryCard(summary: data.grade.termSummary),
              const SizedBox(height: AppSpacing.space16),
              if (_TrendCard.hasTrend(data.gradeTrend)) ...[
                _TrendCard(points: data.gradeTrend),
                const SizedBox(height: AppSpacing.space16),
              ],
              if (subjects.isEmpty)
                const _EmptyGrades()
              else
                for (final subject in subjects) ...[
                  SubjectGradesCard(subject: subject),
                  const SizedBox(height: AppSpacing.space16),
                ],
            ],
          );
        },
      ),
    );
  }
}

/// The three headline term numbers the breakdown carries: term average, term GPA and credits.
/// The child's own screen shows a fourth — cumulative GPA through the term — which the breakdown
/// endpoint does not return; every value renders as "—" rather than a fabricated zero when its
/// summary has not been materialised yet.
class _TermSummaryCard extends StatelessWidget {
  const _TermSummaryCard({required this.summary});

  final PublishedTermSummary summary;

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
                Text('parent.childDetail.grades.termSummary'.tr(), style: textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: AppSpacing.space16),
            Wrap(
              spacing: AppSpacing.space24,
              runSpacing: AppSpacing.space16,
              children: [
                _Stat(
                  label: 'parent.childDetail.grades.termAverage'.tr(),
                  value: _percent(summary.termAveragePercentage),
                ),
                _Stat(
                  label: 'parent.childDetail.grades.gpa'.tr(),
                  value: _decimal(summary.termGpa),
                ),
                _Stat(
                  label: 'parent.childDetail.grades.credits'.tr(),
                  value: _decimal(summary.totalCredits),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// The child's term-average trajectory, oldest term first, as the breakdown returns it (already
/// ordered by academic year then term sequence server-side). Rendered as a compact list rather
/// than the child screen's sparkline — the breakdown carries no term sequence numbers to plot a
/// faithful x-axis — with a plain-language line for the change since the previous term.
class _TrendCard extends StatelessWidget {
  const _TrendCard({required this.points});

  final List<GradeTrendPoint> points;

  /// Whether there are at least two terms with a recorded average — one point is not a trend.
  static bool hasTrend(List<GradeTrendPoint> points) =>
      points.where((p) => p.termAveragePercentage != null).length >= 2;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final averaged = [
      for (final point in points)
        if (point.termAveragePercentage != null) point,
    ];

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.show_chart, size: 20, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Text('parent.childDetail.grades.trend'.tr(), style: textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            for (final (index, point) in averaged.indexed)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
                child: Row(
                  children: [
                    Expanded(child: Text(point.termName, style: textTheme.bodyMedium)),
                    Text(
                      '${_trim(point.termAveragePercentage!)}%',
                      style: textTheme.bodyMedium?.copyWith(
                        fontWeight: index == averaged.length - 1
                            ? FontWeight.w700
                            : FontWeight.w400,
                      ),
                    ),
                  ],
                ),
              ),
            if (_deltaLabel(averaged) case final label?) ...[
              const SizedBox(height: AppSpacing.space8),
              Text(
                label,
                style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String? _deltaLabel(List<GradeTrendPoint> averaged) {
    if (averaged.length < 2) return null;
    final delta =
        (averaged.last.termAveragePercentage! - averaged[averaged.length - 2].termAveragePercentage!)
            .round();
    if (delta > 0) {
      return 'parent.grades.trendUp'.tr(namedArgs: {'points': delta.toString()});
    }
    if (delta < 0) {
      return 'parent.grades.trendDown'.tr(namedArgs: {'points': (-delta).toString()});
    }
    return 'parent.grades.trendFlat'.tr();
  }
}

/// The "nothing published yet" line, shown under the term summary rather than replacing the
/// whole tab — a non-scrolling row so it nests inside the view's `ListView` (mirrors the student
/// grades screen's own `_EmptyTerm`).
class _EmptyGrades extends StatelessWidget {
  const _EmptyGrades();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline, size: 20, color: colorScheme.onSurfaceVariant),
          const SizedBox(width: AppSpacing.space8),
          Expanded(
            child: Text(
              'parent.childDetail.grades.empty'.tr(),
              style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
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
        Text(value, style: textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
      ],
    );
  }
}

String _percent(num? value) => value == null ? '—' : '${_trim(value)}%';

String _decimal(num? value) => value == null ? '—' : _trim(value);

/// Up to two decimals, trailing zeros dropped — "3.5", "92", "17.25". Matches the child grades
/// screen's own formatting (`TermGradeSummaryCard`).
String _trim(num value) {
  final fixed = value.toDouble().toStringAsFixed(2);
  return fixed.contains('.') ? fixed.replaceFirst(RegExp(r'\.?0+$'), '') : fixed;
}
