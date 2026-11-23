import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/predicted_grades_providers.dart';
import '../../domain/predicted_grades.dart';

/// The "Predicted grades" block of the results screen (000254): the grades the student's teachers
/// predict, by year, subject and period. Read-only. Takes no space at all unless the school shows
/// predicted grades to students and parents and at least one exists — including while loading and
/// on an error, since most schools never use them.
class PredictedGradesSection extends ConsumerWidget {
  const PredictedGradesSection({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final years =
        ref.watch(studentPredictedGradesProvider(studentId)).value ??
        const <PredictedGradesYear>[];
    if (years.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'academicResults.predicted.title'.tr(),
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.space4),
        Text(
          'academicResults.predicted.help'.tr(),
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.space8),
        for (final year in years) _YearCard(year: year),
        const SizedBox(height: AppSpacing.space8),
      ],
    );
  }
}

class _YearCard extends StatelessWidget {
  const _YearCard({required this.year});

  final PredictedGradesYear year;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final place = [
      ?year.gradeLevelName,
      ?year.sectionName,
    ].where((part) => part.isNotEmpty).join(' ');
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              [year.yearName, place].where((p) => p.isNotEmpty).join(' · '),
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: AppSpacing.space8),
            for (final grade in year.grades)
              Padding(
                padding: const EdgeInsets.symmetric(
                  vertical: AppSpacing.space4,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${grade.subjectName} · '
                        '${grade.termName ?? 'academicResults.predicted.wholeYear'.tr()}',
                        style: theme.textTheme.bodyMedium,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space8),
                    Text(grade.gradeLabel, style: theme.textTheme.titleMedium),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
