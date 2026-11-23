import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/graduation_requirements_providers.dart';
import '../../domain/graduation_requirements.dart';
import 'academic_result_widgets.dart';
import 'status_pill.dart';

/// The read-only "Graduation requirements" block of the results screen: each requirement set the
/// school shows to students and parents, and where the student stands on every rule (met, not met
/// with how far they are from it, or in progress while the current year is not finalized).
///
/// Shown only when there is something to show: nothing while loading, on an error, or when no set
/// applies or none is shown to students and parents — most schools never set one up.
class GraduationRequirementsSection extends ConsumerWidget {
  const GraduationRequirementsSection({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sets =
        ref.watch(studentGraduationChecklistProvider(studentId)).value ??
        const <GraduationSetChecklist>[];
    if (sets.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'academicResults.graduation.title'.tr(),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.space8),
          for (final set in sets) _SetCard(set: set),
        ],
      ),
    );
  }
}

/// "Met", "Not met", "In progress" (or a neutral label for a status a newer API might send).
String graduationStatusLabel(GraduationStatus status) => switch (status) {
  GraduationStatus.met => 'academicResults.graduation.status.met'.tr(),
  GraduationStatus.notMet => 'academicResults.graduation.status.notMet'.tr(),
  GraduationStatus.pending => 'academicResults.graduation.status.pending'.tr(),
  GraduationStatus.unknown => 'academicResults.graduation.status.unknown'.tr(),
};

class GraduationStatusPill extends StatelessWidget {
  const GraduationStatusPill({required this.status, super.key});

  final GraduationStatus status;

  @override
  Widget build(BuildContext context) => StatusPill(
    label: graduationStatusLabel(status),
    tone: switch (status) {
      GraduationStatus.met => StatusPillTone.success,
      GraduationStatus.notMet => StatusPillTone.danger,
      GraduationStatus.pending => StatusPillTone.warning,
      GraduationStatus.unknown => StatusPillTone.neutral,
    },
  );
}

class _SetCard extends StatelessWidget {
  const _SetCard({required this.set});

  final GraduationSetChecklist set;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
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
                  child: Text(set.name, style: theme.textTheme.titleSmall),
                ),
                GraduationStatusPill(status: set.status),
              ],
            ),
            Text(
              'academicResults.graduation.setProgress'.tr(
                namedArgs: {
                  'met': '${set.rulesMet}',
                  'total': '${set.rulesTotal}',
                },
              ),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.space8),
            for (final rule in set.rules) _RuleRow(rule: rule),
          ],
        ),
      ),
    );
  }
}

class _RuleRow extends StatelessWidget {
  const _RuleRow({required this.rule});

  final GraduationRule rule;

  String get _label {
    final group = rule.groupName ?? '';
    return switch (rule.type) {
      GraduationRuleType.totalCredits =>
        'academicResults.graduation.rule.totalCredits'.tr(),
      GraduationRuleType.groupCredits =>
        'academicResults.graduation.rule.groupCredits'.tr(
          namedArgs: {'group': group},
        ),
      GraduationRuleType.subjectsPassed =>
        'academicResults.graduation.rule.subjectsPassed'.tr(
          namedArgs: {'group': group},
        ),
      GraduationRuleType.cumulativeGpa =>
        'academicResults.graduation.rule.cumulativeGpa'.tr(),
      GraduationRuleType.cumulativeAverage =>
        'academicResults.graduation.rule.cumulativeAverage'.tr(),
      GraduationRuleType.externalExam =>
        rule.examName ?? 'academicResults.graduation.rule.unknown'.tr(),
      GraduationRuleType.unknown =>
        'academicResults.graduation.rule.unknown'.tr(),
    };
  }

  /// "2 of 4" for credits and subjects; "3.1 (minimum 2.5)" for a GPA, average or exam total.
  String? get _progress {
    final current = rule.current;
    final required = rule.required;
    String format(double value) =>
        rule.type == GraduationRuleType.cumulativeAverage
        ? formatResultPercent(value)
        : formatResultNumber(value);
    switch (rule.type) {
      case GraduationRuleType.totalCredits:
      case GraduationRuleType.groupCredits:
      case GraduationRuleType.subjectsPassed:
        if (required == null) return null;
        return 'academicResults.graduation.progress.of'.tr(
          namedArgs: {
            'current': formatResultNumber(current ?? 0),
            'required': format(required),
          },
        );
      case GraduationRuleType.externalExam when required == null:
        return rule.status == GraduationStatus.met
            ? 'academicResults.graduation.progress.recorded'.tr()
            : 'academicResults.graduation.progress.notRecorded'.tr();
      case GraduationRuleType.cumulativeGpa:
      case GraduationRuleType.cumulativeAverage:
      case GraduationRuleType.externalExam:
        if (required == null) return null;
        return 'academicResults.graduation.progress.minimum'.tr(
          namedArgs: {
            'current': current == null ? '—' : format(current),
            'required': format(required),
          },
        );
      case GraduationRuleType.unknown:
        return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final progress = _progress;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(_label, style: theme.textTheme.bodyMedium),
                if (progress != null)
                  Text(
                    progress,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                if (rule.type == GraduationRuleType.subjectsPassed &&
                    rule.missingSubjects.isNotEmpty)
                  Text(
                    'academicResults.graduation.missing'.tr(
                      namedArgs: {'subjects': rule.missingSubjects.join(', ')},
                    ),
                    style: theme.textTheme.bodySmall,
                  ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.space8),
          GraduationStatusPill(status: rule.status),
        ],
      ),
    );
  }
}
