import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/child_comparison_report.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/application/grade_providers.dart' show academicYearTermsProvider;
import '../application/comparison_providers.dart';
import 'widgets/child_detail_placeholders.dart';
import 'widgets/comparison_bar_card.dart';
import 'widgets/comparison_grade_trend_card.dart';
import 'widgets/comparison_term_selector.dart';

/// Side-by-side comparison of every child linked to this parent — grade trend, attendance, and
/// assignment completion — for one term at a time.
///
/// Requires at least two linked children: comparing one child against itself isn't a comparison,
/// so the screen says that plainly (with the current linked count) rather than rendering a chart
/// with a single series. Carries no export or share action — see [_ShareAction] — by deliberate
/// choice, not oversight.
class ChildComparisonScreen extends ConsumerWidget {
  const ChildComparisonScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final reportAsync = ref.watch(comparisonReportProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text('parent.comparison.title'.tr()),
        actions: const [_ShareAction()],
      ),
      body: reportAsync.when(
        loading: () => const ChildDetailSkeleton(),
        error: (_, _) => const ChildDetailMessage(
          messageKey: 'parent.comparison.error',
          icon: Icons.error_outline,
        ),
        data: (report) {
          if (report.children.length < 2) {
            return ChildDetailMessage(
              messageKey: 'parent.comparison.requiresTwoChildren.message',
              hintKey: 'parent.comparison.requiresTwoChildren.hint',
              icon: Icons.groups_outlined,
              messageArgs: {'count': report.children.length.toString()},
            );
          }
          return _ComparisonBody(report: report);
        },
      ),
    );
  }
}

/// A visibly-present, permanently-disabled share/export action rather than an absent one: the
/// comparison view puts more than one child's academic data on the same screen, and this app has
/// no vetted way to hand that off outside itself yet, so the button stays here — inert, with a
/// tooltip explaining why — instead of silently missing.
class _ShareAction extends StatelessWidget {
  const _ShareAction();

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: const Icon(Icons.ios_share_outlined),
      tooltip: 'parent.comparison.shareDisabled'.tr(),
      onPressed: null,
    );
  }
}

class _ComparisonBody extends ConsumerWidget {
  const _ComparisonBody({required this.report});

  final ChildComparisonReport report;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final children = report.children;
    final terms = ref.watch(academicYearTermsProvider).value ?? const [];
    final axisTerms = [
      for (final term in terms)
        if (children.any((child) => child.gradeTrend.any((point) => point.termId == term.id)))
          term,
    ];

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(comparisonReportProvider),
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const ComparisonTermSelector(),
          const SizedBox(height: AppSpacing.space16),
          ComparisonGradeTrendCard(children: children, axisTerms: axisTerms),
          const SizedBox(height: AppSpacing.space16),
          ComparisonBarCard(
            titleKey: 'parent.comparison.attendance.title',
            icon: Icons.event_available_outlined,
            barColor: Theme.of(context).colorScheme.primary,
            data: [
              for (final child in children)
                ComparisonBarDatum(
                  label: child.studentName,
                  value: child.attendance.presentPercent.toDouble(),
                  valueLabel: 'parent.comparison.attendance.presentShare'.tr(
                    namedArgs: {'percent': child.attendance.presentPercent.round().toString()},
                  ),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.space16),
          ComparisonBarCard(
            titleKey: 'parent.comparison.completion.title',
            icon: Icons.fact_check_outlined,
            barColor: Theme.of(context).colorScheme.tertiary,
            data: [
              for (final child in children)
                ComparisonBarDatum(
                  label: child.studentName,
                  value: child.assignments.completionPercent.toDouble(),
                  valueLabel: 'parent.comparison.completion.share'.tr(
                    namedArgs: {'percent': child.assignments.completionPercent.round().toString()},
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
