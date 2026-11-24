import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/academic_equivalency_providers.dart';
import '../../domain/academic_equivalency.dart';
import 'academic_result_widgets.dart';
import 'status_pill.dart';

/// The read-only "Multi-year result" block of the results screen: for each configuration the
/// school shows to students and parents, the result weighted across several grade levels
/// ("Grade 11 40% + Grade 12 60%"), overall and per subject, with each year's own figure. Pending
/// while a year is not finalized.
///
/// Shown only when there is something to show: nothing while loading, on an error, or when no
/// configuration applies or none is shown.
class MultiYearSection extends ConsumerWidget {
  const MultiYearSection({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final results =
        ref.watch(studentMultiYearResultsProvider(studentId)).value ??
        const <MultiYearResult>[];
    if (results.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'academicResults.multiYear.title'.tr(),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.space8),
          for (final result in results) _ResultCard(result: result),
        ],
      ),
    );
  }
}

/// "Complete", "Pending", "Incomplete" (or a neutral label for a newer status).
String multiYearStatusLabel(MultiYearStatus status) => switch (status) {
  MultiYearStatus.complete => 'academicResults.multiYear.status.complete'.tr(),
  MultiYearStatus.pending => 'academicResults.multiYear.status.pending'.tr(),
  MultiYearStatus.incomplete =>
    'academicResults.multiYear.status.incomplete'.tr(),
  MultiYearStatus.unknown => 'academicResults.multiYear.status.unknown'.tr(),
};

String _yearStatusLabel(MultiYearYearStatus status) => switch (status) {
  MultiYearYearStatus.finalized =>
    'academicResults.multiYear.yearStatus.finalized'.tr(),
  MultiYearYearStatus.incomplete =>
    'academicResults.multiYear.yearStatus.incomplete'.tr(),
  MultiYearYearStatus.pending =>
    'academicResults.multiYear.yearStatus.pending'.tr(),
  MultiYearYearStatus.missing =>
    'academicResults.multiYear.yearStatus.missing'.tr(),
  MultiYearYearStatus.unknown => '—',
};

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.result});

  final MultiYearResult result;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final overall = result.overallPercentage;
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(result.name, style: theme.textTheme.titleSmall),
                ),
                StatusPill(
                  label: multiYearStatusLabel(result.status),
                  tone: switch (result.status) {
                    MultiYearStatus.complete => StatusPillTone.success,
                    MultiYearStatus.pending => StatusPillTone.warning,
                    MultiYearStatus.incomplete => StatusPillTone.danger,
                    MultiYearStatus.unknown => StatusPillTone.neutral,
                  },
                ),
              ],
            ),
            if (overall != null) ...[
              const SizedBox(height: AppSpacing.space4),
              Text(
                'academicResults.multiYear.overall'.tr(
                  namedArgs: {'percentage': formatResultPercent(overall)},
                ),
                style: theme.textTheme.headlineSmall,
              ),
            ],
            const SizedBox(height: AppSpacing.space8),
            for (final year in result.years)
              Padding(
                padding: const EdgeInsets.symmetric(
                  vertical: AppSpacing.space4,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'academicResults.multiYear.yearWeight'.tr(
                              namedArgs: {
                                'grade': year.gradeLevelName,
                                'share': formatResultPercent(year.share),
                              },
                            ),
                            style: theme.textTheme.bodyMedium,
                          ),
                          Text(
                            [
                              _yearStatusLabel(year.status),
                              if (year.academicYearName case final String name)
                                name,
                            ].join(' · '),
                            style: muted,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space8),
                    Text(
                      formatResultPercent(year.overallPercentage),
                      style: theme.textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
            if (result.subjects.isNotEmpty) ...[
              const Divider(),
              Text(
                'academicResults.multiYear.subjects'.tr(),
                style: theme.textTheme.labelLarge,
              ),
              for (final subject in result.subjects)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: AppSpacing.space4,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              subject.name,
                              style: theme.textTheme.bodyMedium,
                            ),
                            Text(
                              subject.byYear
                                  .map(formatResultPercent)
                                  .join(' · '),
                              style: muted,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: AppSpacing.space8),
                      Text(
                        formatResultPercent(subject.percentage),
                        style: theme.textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}
