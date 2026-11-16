import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/grade_trend_point.dart';
import '../../../../core/api/generated/models/published_term_summary.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/application/released_marks_providers.dart';
import '../../../student/presentation/academic_results_screen.dart';
import '../../../student/presentation/released_marks_screen.dart';
import '../../../student/presentation/widgets/released_marks_widgets.dart';
import '../../../student/presentation/widgets/subject_grades_card.dart';
import '../../application/child_detail_providers.dart';
import '../../domain/child_subject_grades.dart';
import 'child_detail_placeholders.dart';
import '../../../../design/layout/bottom_inset_padding.dart';

/// The Grades tab of `ChildDetailScreen`: first the child's approved exam marks
/// ([ReleasedMarksSummaryCard], the newest few with a link to all of them — the same marks the
/// child sees in their own "Exam marks" tab), then the child's term summary, their term-over-term
/// average trend, and one `SubjectGradesCard` per course — the same per-subject breakdown widget
/// the child sees on their own grades screen, so the numbers match exactly (acceptance criterion
/// "data parity with the child's own student views").
///
/// The exam marks come from their own endpoint, so they show even when the coursework breakdown
/// fails to load.
class ChildGradesView extends ConsumerWidget {
  const ChildGradesView({required this.studentId, this.studentName, super.key});

  final String studentId;

  /// The child's name, for the official-results screen's header.
  final String? studentName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final breakdown = ref.watch(childBreakdownProvider(studentId));

    // The exam marks and official-results entry lead the tab in every state but the first load.
    Widget page(List<Widget> rest) => ListView(
      padding: const EdgeInsets.all(AppSpacing.space16).withBottomInset(context),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        ReleasedMarksSummaryCard(
          studentId: studentId,
          onSeeAll: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => ReleasedMarksScreen(studentId: studentId, studentName: studentName),
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.space16),
        _OfficialResultsTile(studentId: studentId, studentName: studentName),
        const SizedBox(height: AppSpacing.space16),
        ...rest,
      ],
    );

    return RefreshIndicator(
      onRefresh: () async {
        ref
          ..invalidate(childBreakdownProvider(studentId))
          ..invalidate(studentReleasedMarksProvider(studentId));
      },
      child: breakdown.when(
        loading: () => const ChildDetailSkeleton(),
        error: (_, _) => page(const [
          _InlineMessage(messageKey: 'parent.childDetail.error', icon: Icons.error_outline),
        ]),
        data: (data) {
          final subjects = groupChildSubjects(data.grade.grades);
          return page([
            _TermSummaryCard(summary: data.grade.termSummary),
            const SizedBox(height: AppSpacing.space16),
            if (_TrendCard.hasTrend(data.gradeTrend)) ...[
              _TrendCard(points: data.gradeTrend),
              const SizedBox(height: AppSpacing.space16),
            ],
            if (subjects.isEmpty)
              const _InlineMessage(
                messageKey: 'parent.childDetail.grades.empty',
                icon: Icons.info_outline,
              )
            else
              for (final subject in subjects) ...[
                SubjectGradesCard(subject: subject),
                const SizedBox(height: AppSpacing.space16),
              ],
          ]);
        },
      ),
    );
  }
}

/// Opens the child's official (finalized) results, certificates and report cards — the same
/// [AcademicResultsScreen] the child sees from their own grades screen.
class _OfficialResultsTile extends StatelessWidget {
  const _OfficialResultsTile({required this.studentId, this.studentName});

  final String studentId;
  final String? studentName;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        leading: const Icon(Icons.workspace_premium_outlined),
        title: Text('academicResults.entry'.tr()),
        subtitle: Text('academicResults.entrySubtitle'.tr()),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => AcademicResultsScreen(studentId: studentId, studentName: studentName),
          ),
        ),
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
        (averaged.last.termAveragePercentage! -
                averaged[averaged.length - 2].termAveragePercentage!)
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

/// A one-line message inside the tab's list rather than replacing the whole tab — "nothing
/// published yet" under the term summary, or the breakdown's load error under the exam marks. A
/// non-scrolling row so it nests inside the view's `ListView` (mirrors the student grades
/// screen's own `_EmptyTerm`).
class _InlineMessage extends StatelessWidget {
  const _InlineMessage({required this.messageKey, required this.icon});

  final String messageKey;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: colorScheme.onSurfaceVariant),
          const SizedBox(width: AppSpacing.space8),
          Expanded(
            child: Text(
              messageKey.tr(),
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
        Text(label, style: textTheme.labelMedium?.copyWith(color: colorScheme.onSurfaceVariant)),
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
