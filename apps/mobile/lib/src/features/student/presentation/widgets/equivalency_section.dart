import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/academic_equivalency_providers.dart';
import '../../domain/academic_equivalency.dart';
import 'academic_result_widgets.dart';
import 'status_pill.dart';

/// The read-only "Tawjihi equivalency (estimate)" block of the results screen: for each rule set
/// the school shows to students and parents, the estimated Tawjihi-equivalent percentage (or why
/// there is none yet), always labelled as an estimate the school confirms — never an official
/// Ministry conversion — with each part, the subjects counted and any missing data.
///
/// Shown only when there is something to show: nothing while loading, on an error, or when no
/// rule set applies or none is shown — most schools never set one up.
class EquivalencySection extends ConsumerWidget {
  const EquivalencySection({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final estimates =
        ref.watch(studentEquivalencyProvider(studentId)).value ??
        const <EquivalencyEstimate>[];
    if (estimates.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'academicResults.equivalency.title'.tr(),
            style: theme.textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.space4),
          Text(
            'academicResults.equivalency.notice'.tr(),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: AppSpacing.space8),
          for (final estimate in estimates) _EstimateCard(estimate: estimate),
        ],
      ),
    );
  }
}

/// "Estimated", "Missing data", "No estimate" (or a neutral label for a newer status).
String equivalencyStatusLabel(EquivalencyStatus status) => switch (status) {
  EquivalencyStatus.estimated =>
    'academicResults.equivalency.status.estimated'.tr(),
  EquivalencyStatus.incomplete =>
    'academicResults.equivalency.status.incomplete'.tr(),
  EquivalencyStatus.notEligible =>
    'academicResults.equivalency.status.notEligible'.tr(),
  EquivalencyStatus.unknown =>
    'academicResults.equivalency.status.unknown'.tr(),
};

StatusPillTone _tone(EquivalencyStatus status) => switch (status) {
  EquivalencyStatus.estimated => StatusPillTone.success,
  EquivalencyStatus.incomplete => StatusPillTone.warning,
  EquivalencyStatus.notEligible => StatusPillTone.danger,
  EquivalencyStatus.unknown => StatusPillTone.neutral,
};

/// The issue codes the app knows a sentence for; any other code reads as a generic sentence.
const _knownIssueCodes = {
  'NO_EXAM_RESULTS': 'noExamResults',
  'TOO_FEW_SUBJECTS': 'tooFewSubjects',
  'REQUIRED_SUBJECT_MISSING': 'requiredSubjectMissing',
  'UNMAPPED_GRADE': 'unmappedGrade',
  'NO_DIPLOMA_RESULT': 'noDiplomaResult',
  'DIPLOMA_PENDING': 'diplomaPending',
  'DIPLOMA_NOT_AWARDED': 'diplomaNotAwarded',
  'NO_GPA': 'noGpa',
  'NO_EXAM_TOTAL': 'noExamTotal',
  'BELOW_CONVERSION_TABLE': 'belowConversionTable',
  'CURRENT_YEAR_PENDING': 'currentYearPending',
  'OPTIONAL_PART_SKIPPED': 'optionalPartSkipped',
  'NO_PARTS': 'noParts',
};

/// One issue as a sentence, naming the part, subject, exam, grade and figures where they apply.
String equivalencyIssueText(
  EquivalencyIssue issue,
  List<EquivalencyPart> parts,
) {
  final key = _knownIssueCodes[issue.code];
  if (key == null) return 'academicResults.equivalency.issue.unknown'.tr();
  final partIndex = issue.partIndex;
  final part = partIndex != null && partIndex >= 0 && partIndex < parts.length
      ? parts[partIndex].label
      : '';
  return 'academicResults.equivalency.issue.$key'.tr(
    namedArgs: {
      'part': part,
      'subject': issue.subjectName ?? '',
      'exam': issue.examName ?? '',
      'grade': issue.grade ?? '',
      'required': issue.required == null
          ? '—'
          : formatResultNumber(issue.required!),
      'actual': issue.actual == null ? '—' : formatResultNumber(issue.actual!),
    },
  );
}

class _EstimateCard extends StatelessWidget {
  const _EstimateCard({required this.estimate});

  final EquivalencyEstimate estimate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final percentage = estimate.percentage;
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
                  child: Text(
                    estimate.setName,
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                StatusPill(
                  label: equivalencyStatusLabel(estimate.status),
                  tone: _tone(estimate.status),
                ),
              ],
            ),
            if (percentage != null) ...[
              const SizedBox(height: AppSpacing.space4),
              Text(
                'academicResults.equivalency.estimate'.tr(
                  namedArgs: {'percentage': formatResultPercent(percentage)},
                ),
                style: theme.textTheme.headlineSmall,
              ),
            ],
            const SizedBox(height: AppSpacing.space8),
            for (final part in estimate.parts) _PartRow(part: part),
            for (final issue in estimate.issues)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.space4),
                child: Text(
                  equivalencyIssueText(issue, estimate.parts),
                  style: issue.kind == EquivalencyIssueKind.note
                      ? muted
                      : theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.error,
                        ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _PartRow extends StatelessWidget {
  const _PartRow({required this.part});

  final EquivalencyPart part;

  String get _figure {
    final percentage = part.percentage;
    final share = part.share;
    return switch (part.status) {
      EquivalencyPartStatus.counted when share != null =>
        'academicResults.equivalency.partShare'.tr(
          namedArgs: {
            'percentage': formatResultPercent(percentage),
            'share': formatResultPercent(share),
          },
        ),
      EquivalencyPartStatus.counted => formatResultPercent(percentage),
      EquivalencyPartStatus.missing =>
        'academicResults.equivalency.partStatus.missing'.tr(),
      EquivalencyPartStatus.skipped =>
        'academicResults.equivalency.partStatus.skipped'.tr(),
      EquivalencyPartStatus.notEligible =>
        'academicResults.equivalency.partStatus.notEligible'.tr(),
      EquivalencyPartStatus.unknown => '—',
    };
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final source = part.sourceValue;
    final sourceMax = part.sourceMax;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(part.label, style: theme.textTheme.bodyMedium),
              ),
              const SizedBox(width: AppSpacing.space8),
              Text(_figure, style: theme.textTheme.bodyMedium),
            ],
          ),
          if (source != null)
            Text(
              sourceMax == null
                  ? 'academicResults.equivalency.source'.tr(
                      namedArgs: {'value': formatResultNumber(source)},
                    )
                  : 'academicResults.equivalency.sourceOf'.tr(
                      namedArgs: {
                        'value': formatResultNumber(source),
                        'max': formatResultNumber(sourceMax),
                      },
                    ),
              style: muted,
            ),
          for (final step in part.subjects)
            Text(
              'academicResults.equivalency.subjectStep'.tr(
                    namedArgs: {
                      'subject': step.subjectName,
                      'grade': step.grade,
                      'percentage': formatResultPercent(step.percentage),
                    },
                  ) +
                  (step.counted
                      ? ''
                      : ' · ${'academicResults.equivalency.notCounted'.tr()}'),
              style: step.counted ? theme.textTheme.bodySmall : muted,
            ),
        ],
      ),
    );
  }
}
