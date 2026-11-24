import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/diploma_providers.dart';
import '../../domain/academic_results.dart';
import '../../domain/diploma_prediction.dart';
import 'academic_result_widgets.dart';
import 'status_pill.dart';

/// Up to two decimals, or a dash for a missing figure.
String _n(double? value) => value == null ? '—' : formatResultNumber(value);

/// One failing condition in words ("Total 22 is below 24"); an unknown code shows as itself.
String diplomaConditionText(DiplomaFailingCondition condition) {
  final key = 'academicResults.diploma.failing.${condition.code}';
  final text = key.tr(
    namedArgs: {
      'required': _n(condition.required),
      'actual': _n(condition.actual),
      'points': _n(condition.points),
      'level': condition.level ?? '',
      'grade': condition.grade ?? '',
      'component': switch (condition.component) {
        'tok' => 'academicResults.diploma.tok'.tr(),
        'ee' => 'academicResults.diploma.ee'.tr(),
        _ => '',
      },
    },
  );
  return text == key ? condition.code : text;
}

/// The IB Diploma part of a result (000262): award status, total out of 45, core points, the TOK,
/// Extended Essay and CAS used, and why the diploma is not awarded (or what is still missing).
class DiplomaOutcomeView extends StatelessWidget {
  const DiplomaOutcomeView({required this.diploma, super.key});

  final DiplomaOutcome diploma;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final cas = switch (diploma.casComplete) {
      true => 'academicResults.diploma.casComplete'.tr(),
      false => 'academicResults.diploma.casIncomplete'.tr(),
      null => '—',
    };
    final notes = diploma.failingConditions.isNotEmpty
        ? diploma.failingConditions.map(diplomaConditionText).toList()
        : diploma.status == DiplomaStatus.pending
        ? [
            for (final reason in diploma.pendingReasons)
              'academicResults.diploma.pending.$reason'.tr(),
          ]
        : const <String>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: AppSpacing.space8,
          runSpacing: AppSpacing.space4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              'academicResults.diploma.title'.tr(),
              style: theme.textTheme.titleSmall,
            ),
            StatusPill(
              label: 'academicResults.diploma.status.${diploma.status.name}'
                  .tr(),
              tone: switch (diploma.status) {
                DiplomaStatus.awarded => StatusPillTone.success,
                DiplomaStatus.notAwarded => StatusPillTone.danger,
                DiplomaStatus.pending ||
                DiplomaStatus.unknown => StatusPillTone.neutral,
              },
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.space4),
        Text(
          [
            diploma.total == null
                ? 'academicResults.diploma.totalPending'.tr()
                : 'academicResults.diploma.total'.tr(
                    namedArgs: {
                      'value': formatResultNumber(diploma.total!),
                      'max': formatResultNumber(diploma.max),
                    },
                  ),
            'academicResults.diploma.corePoints'.tr(
              namedArgs: {'points': _n(diploma.corePoints)},
            ),
          ].join(' · '),
          style: theme.textTheme.bodyMedium,
        ),
        Text(
          'academicResults.diploma.core'.tr(
            namedArgs: {
              'tok': diploma.tokGrade ?? '—',
              'ee': diploma.eeGrade ?? '—',
              'cas': cas,
            },
          ),
          style: muted,
        ),
        for (final note in notes) Text('• $note', style: muted),
      ],
    );
  }
}

/// The "IB Diploma prediction" block of the results screen: the predicted total from the
/// teachers' predicted grades and predicted core grades. Takes no space unless the school shows
/// a prediction to the student and their parents (also while loading and on an error).
class DiplomaPredictionSection extends ConsumerWidget {
  const DiplomaPredictionSection({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final years =
        ref.watch(studentDiplomaPredictionProvider(studentId)).value ??
        const <DiplomaPredictionYear>[];
    if (years.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'academicResults.diploma.predictedTitle'.tr(),
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.space4),
        Text(
          'academicResults.diploma.predictedHelp'.tr(),
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.space8),
        for (final year in years)
          Card(
            margin: const EdgeInsets.only(bottom: AppSpacing.space12),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    [
                      year.yearName,
                      '${year.gradeLevelName} ${year.sectionName}'.trim(),
                    ].where((part) => part.isNotEmpty).join(' · '),
                    style: theme.textTheme.titleSmall,
                  ),
                  const SizedBox(height: AppSpacing.space8),
                  DiplomaOutcomeView(diploma: year.predictedResult!),
                ],
              ),
            ),
          ),
        const SizedBox(height: AppSpacing.space8),
      ],
    );
  }
}
