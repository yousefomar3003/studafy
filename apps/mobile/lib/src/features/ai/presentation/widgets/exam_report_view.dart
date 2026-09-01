import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/exam.dart';
import 'exam_study_reference_chip.dart';

/// The submitted exam's scoring report: overall score, then a per-topic breakdown with
/// tappable study references for anything weak — "scoring report maps weaknesses to materials
/// with cited study references."
class ExamReportView extends StatelessWidget {
  const ExamReportView({required this.report, required this.onStartNew, super.key});

  final ExamReport report;
  final VoidCallback onStartNew;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      children: [
        _ScoreHeader(report: report),
        const SizedBox(height: AppSpacing.space24),
        Text('examMode.report.topics'.tr(), style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: AppSpacing.space8),
        for (final topic in report.topics) _TopicCard(topic: topic),
        const SizedBox(height: AppSpacing.space8),
        OutlinedButton(onPressed: onStartNew, child: Text('examMode.report.newExam'.tr())),
      ],
    );
  }
}

class _ScoreHeader extends StatelessWidget {
  const _ScoreHeader({required this.report});

  final ExamReport report;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Column(
      children: [
        Text('${report.percentage}%', style: textTheme.displaySmall),
        const SizedBox(height: AppSpacing.space4),
        Text(
          'examMode.report.score'.tr(
            namedArgs: {'correct': '${report.correctCount}', 'total': '${report.totalItems}'},
          ),
          style: TextStyle(color: colorScheme.onSurfaceVariant),
        ),
      ],
    );
  }
}

class _TopicCard extends StatelessWidget {
  const _TopicCard({required this.topic});

  final ExamTopicReport topic;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final title = topic.materialTitle ?? 'examMode.citation.fallback'.tr();

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(title, style: textTheme.titleSmall)),
                if (topic.weak)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: colorScheme.errorContainer,
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      'examMode.report.weak'.tr(),
                      style: textTheme.labelSmall?.copyWith(color: colorScheme.onErrorContainer),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.space4),
            Text(
              '${topic.percentage}% · ${topic.correct}/${topic.total}',
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
            if (topic.studyReferences.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.space8),
              Text('examMode.report.studyReferences'.tr(), style: textTheme.labelMedium),
              const SizedBox(height: AppSpacing.space4),
              Wrap(
                spacing: AppSpacing.space8,
                runSpacing: AppSpacing.space8,
                children: [
                  for (final reference in topic.studyReferences)
                    ExamStudyReferenceChip(
                      materialId: topic.materialId,
                      materialTitle: topic.materialTitle,
                      reference: reference,
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
