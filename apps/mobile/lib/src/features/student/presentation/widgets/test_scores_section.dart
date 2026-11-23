import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/external_exam_results_providers.dart';
import '../../domain/external_exam_results.dart';
import 'academic_result_widgets.dart';

/// The read-only "Test scores" block of the results screen: the external exams the school
/// recorded for the student (SAT, IELTS, IGCSE finals, Tawjihi...), newest sitting first. The
/// school records them; students and parents only read.
class TestScoresSection extends ConsumerWidget {
  const TestScoresSection({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final results = ref.watch(studentExternalExamResultsProvider(studentId));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'academicResults.testScores.title'.tr(),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.space8),
        ...results.when(
          loading: () => const [
            Padding(
              padding: EdgeInsets.all(AppSpacing.space16),
              child: Center(child: CircularProgressIndicator()),
            ),
          ],
          error: (_, _) => [Text('academicResults.testScores.error'.tr())],
          data: (rows) => rows.isEmpty
              ? [Text('academicResults.testScores.empty'.tr())]
              : [for (final result in rows) _TestScoreCard(result: result)],
        ),
      ],
    );
  }
}

class _TestScoreCard extends StatelessWidget {
  const _TestScoreCard({required this.result});

  final ExternalExamResult result;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final satOn = result.satOn;
    final title = result.subjectName == null
        ? result.examName
        : 'academicResults.testScores.examSubject'.tr(
            namedArgs: {
              'exam': result.examName,
              'subject': result.subjectName!,
            },
          );
    final total = result.totalScore;
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
                Expanded(child: Text(title, style: theme.textTheme.titleSmall)),
                if (total != null)
                  Text(
                    result.totalMax == null
                        ? formatResultNumber(total)
                        : 'academicResults.valueOutOf'.tr(
                            namedArgs: {
                              'value': formatResultNumber(total),
                              'max': formatResultNumber(result.totalMax!),
                            },
                          ),
                    style: theme.textTheme.titleSmall,
                  ),
              ],
            ),
            if (satOn != null)
              Text(
                'academicResults.testScores.satOn'.tr(
                  namedArgs: {
                    'date': DateFormat.yMMMd(
                      context.locale.toString(),
                    ).format(satOn),
                  },
                ),
                style: theme.textTheme.bodySmall,
              ),
            const SizedBox(height: AppSpacing.space4),
            for (final score in result.scores)
              Text(
                'academicResults.testScores.scoreLine'.tr(
                  namedArgs: {
                    'component': score.componentName,
                    'score': score.numericScore != null
                        ? formatResultNumber(score.numericScore!)
                        : (score.labelScore ?? '—'),
                  },
                ),
              ),
            if (result.note != null && result.note!.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.space4),
              Text(result.note!, style: theme.textTheme.bodySmall),
            ],
          ],
        ),
      ),
    );
  }
}
