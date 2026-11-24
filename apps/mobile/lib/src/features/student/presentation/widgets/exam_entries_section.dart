import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/exam_entries_providers.dart';
import '../../domain/exam_entries.dart';
import 'status_pill.dart';

/// The read-only "Exam entries" block of the results screen: the external exam sessions the
/// school entered the student for (IGCSE May/June 2027...), each with its subjects, candidate
/// number and dates. Hidden when the student has none, so a school that does not use exam entries
/// sees nothing new. The school manages entries; students and parents only read.
class ExamEntriesSection extends ConsumerWidget {
  const ExamEntriesSection({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final entries = ref.watch(studentExamEntriesProvider(studentId));
    return entries.when(
      loading: () => const SizedBox.shrink(),
      error: (_, _) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.space16),
        child: Text('academicResults.examEntries.error'.tr()),
      ),
      data: (rows) => rows.isEmpty
          ? const SizedBox.shrink()
          : Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.space16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'academicResults.examEntries.title'.tr(),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: AppSpacing.space8),
                  for (final entry in rows) _ExamEntryCard(entry: entry),
                ],
              ),
            ),
    );
  }
}

/// "Entered", "Withdrawn", or a neutral label for a status a newer API might send.
String examEntryStatusLabel(ExamEntryStatus status) => switch (status) {
  ExamEntryStatus.entered => 'academicResults.examEntries.status.entered'.tr(),
  ExamEntryStatus.withdrawn =>
    'academicResults.examEntries.status.withdrawn'.tr(),
  ExamEntryStatus.unknown => 'academicResults.examEntries.status.unknown'.tr(),
};

class _ExamEntryCard extends StatelessWidget {
  const _ExamEntryCard({required this.entry});

  final StudentExamEntry entry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final format = DateFormat.yMMMd(context.locale.toString());
    final startsOn = entry.startsOn;
    final endsOn = entry.endsOn;
    final title = entry.series.isEmpty
        ? entry.examName
        : 'academicResults.examEntries.examSeries'.tr(
            namedArgs: {'exam': entry.examName, 'series': entry.series},
          );
    final lines = <String>[
      'academicResults.examEntries.candidateNumber'.tr(
        namedArgs: {
          'number':
              entry.candidateNumber ??
              'academicResults.examEntries.noCandidateNumber'.tr(),
        },
      ),
      if (startsOn != null)
        endsOn == null || endsOn == startsOn
            ? 'academicResults.examEntries.examsOn'.tr(
                namedArgs: {'date': format.format(startsOn)},
              )
            : 'academicResults.examEntries.examsBetween'.tr(
                namedArgs: {
                  'from': format.format(startsOn),
                  'to': format.format(endsOn),
                },
              ),
      if (entry.resultsDate != null)
        'academicResults.examEntries.resultsOn'.tr(
          namedArgs: {'date': format.format(entry.resultsDate!)},
        ),
    ];
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
                const SizedBox(width: AppSpacing.space8),
                StatusPill(
                  label: examEntryStatusLabel(entry.status),
                  tone: switch (entry.status) {
                    ExamEntryStatus.entered => StatusPillTone.success,
                    ExamEntryStatus.withdrawn => StatusPillTone.warning,
                    ExamEntryStatus.unknown => StatusPillTone.neutral,
                  },
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space4),
            for (final line in lines)
              Text(line, style: theme.textTheme.bodySmall),
            if (entry.subjects.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.space4),
              for (final subject in entry.subjects) Text(_subjectLine(subject)),
            ],
          ],
        ),
      ),
    );
  }

  /// "Mathematics · Extended · 0580", leaving out what is not set.
  static String _subjectLine(ExamEntrySubject subject) => [
    subject.name ?? 'academicResults.examEntries.unnamedSubject'.tr(),
    ?subject.tier,
    ?subject.optionCode,
  ].join(' · ');
}
