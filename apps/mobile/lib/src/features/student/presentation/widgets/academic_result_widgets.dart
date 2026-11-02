import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/theme/app_semantic_colors.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/academic_results.dart';
import 'status_pill.dart';

/// Up to two decimals, trailing zeros dropped — "92", "87.5", "66.67".
String formatResultNumber(num value) {
  final fixed = value.toDouble().toStringAsFixed(2);
  return fixed.contains('.')
      ? fixed.replaceFirst(RegExp(r'\.?0+$'), '')
      : fixed;
}

String formatResultPercent(num? value) =>
    value == null ? '—' : '${formatResultNumber(value)}%';

/// Promoted (success), supplementary exams (warning), retained (danger), incomplete (neutral).
class AcademicStatusPill extends StatelessWidget {
  const AcademicStatusPill({required this.status, super.key});

  final AcademicStatus status;

  @override
  Widget build(BuildContext context) => StatusPill(
    label: 'academicResults.status.${status.name}'.tr(),
    tone: switch (status) {
      AcademicStatus.promoted => StatusPillTone.success,
      AcademicStatus.supplementary => StatusPillTone.warning,
      AcademicStatus.retained => StatusPillTone.danger,
      AcademicStatus.incomplete => StatusPillTone.neutral,
    },
  );
}

class CertificateStatusPill extends StatelessWidget {
  const CertificateStatusPill({required this.status, super.key});

  final CertificateStatus status;

  @override
  Widget build(BuildContext context) => StatusPill(
    label: 'academicResults.certStatus.${status.name}'.tr(),
    tone: switch (status) {
      CertificateStatus.issued => StatusPillTone.success,
      CertificateStatus.superseded => StatusPillTone.warning,
      CertificateStatus.revoked => StatusPillTone.danger,
    },
  );
}

String certificateKindLabel(String kind) => kind == 'term_report'
    ? 'academicResults.kind.termReport'.tr()
    : 'academicResults.kind.annualCertificate'.tr();

/// The overall line: academic status, average, total, grade and subjects failed.
class OverallResultSummary extends StatelessWidget {
  const OverallResultSummary({required this.overall, super.key});

  final OverallResult overall;

  @override
  Widget build(BuildContext context) {
    final total = overall.totalObtained != null && overall.totalMax != null
        ? '${formatResultNumber(overall.totalObtained!)} / '
              '${formatResultNumber(overall.totalMax!)}'
        : '—';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AcademicStatusPill(status: overall.academicStatus),
        const SizedBox(height: AppSpacing.space12),
        Wrap(
          spacing: AppSpacing.space24,
          runSpacing: AppSpacing.space12,
          children: [
            _Stat(
              label: 'academicResults.average'.tr(),
              value: formatResultPercent(overall.averagePercentage),
            ),
            _Stat(label: 'academicResults.total'.tr(), value: total),
            _Stat(
              label: 'academicResults.grade'.tr(),
              value: overall.gradeLabel ?? '—',
            ),
            _Stat(
              label: 'academicResults.failed'.tr(),
              value: '${overall.subjectsFailed}',
            ),
          ],
        ),
      ],
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: theme.textTheme.labelMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.space4),
        Text(
          value,
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
      ],
    );
  }
}

/// Subject | Marks | % | Grade, one row per subject, with pass/fail (or exempt / incomplete)
/// under the grade and the per-term percentages under the subject name when they can be named.
class SubjectResultsTable extends StatelessWidget {
  const SubjectResultsTable({
    required this.subjects,
    this.termNames = const {},
    super.key,
  });

  final List<SubjectResult> subjects;

  /// Term id → name, for per-term percentages that don't carry their own name.
  final Map<String, String> termNames;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final header = theme.textTheme.labelMedium?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
      fontWeight: FontWeight.w600,
    );

    TableRow row(List<Widget> cells, {Decoration? decoration}) => TableRow(
      decoration: decoration,
      children: [
        for (final cell in cells)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.space4,
              vertical: AppSpacing.space8,
            ),
            child: cell,
          ),
      ],
    );

    return Table(
      columnWidths: const {
        0: FlexColumnWidth(3),
        1: FlexColumnWidth(2),
        2: FlexColumnWidth(1.6),
        3: FlexColumnWidth(2),
      },
      defaultVerticalAlignment: TableCellVerticalAlignment.top,
      children: [
        row(
          [
            Text('academicResults.subjectCol'.tr(), style: header),
            Text('academicResults.marksCol'.tr(), style: header),
            Text('academicResults.percentCol'.tr(), style: header),
            Text('academicResults.gradeCol'.tr(), style: header),
          ],
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(color: theme.colorScheme.outlineVariant),
            ),
          ),
        ),
        for (final subject in subjects)
          row(
            [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(subject.name, style: theme.textTheme.bodyMedium),
                  if (_termLine(subject) case final line?)
                    Text(
                      line,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
              Text(
                subject.isExempt || subject.marksObtained == null
                    ? '—'
                    : '${formatResultNumber(subject.marksObtained!)} / '
                          '${formatResultNumber(subject.maxMarks)}',
                style: theme.textTheme.bodyMedium,
              ),
              Text(
                subject.isExempt
                    ? '—'
                    : formatResultPercent(subject.percentage),
                style: theme.textTheme.bodyMedium,
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (!subject.isExempt && subject.gradeLabel != null)
                    Text(
                      subject.gradeLabel!,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  _SubjectOutcome(subject: subject),
                ],
              ),
            ],
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: theme.colorScheme.outlineVariant.withValues(
                    alpha: 0.5,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  String? _termLine(SubjectResult subject) {
    final parts = <String>[];
    for (final term in subject.terms) {
      final name =
          term.termName ??
          (term.termId == null ? null : termNames[term.termId]);
      if (name == null || term.percentage == null) continue;
      parts.add('$name ${formatResultPercent(term.percentage)}');
    }
    return parts.isEmpty ? null : parts.join(' · ');
  }
}

class _SubjectOutcome extends StatelessWidget {
  const _SubjectOutcome({required this.subject});

  final SubjectResult subject;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (label, color) = subject.isExempt
        ? ('academicResults.exempt'.tr(), theme.colorScheme.onSurfaceVariant)
        : subject.isIncomplete
        ? (
            'academicResults.subjectIncomplete'.tr(),
            theme.colorScheme.onSurfaceVariant,
          )
        : subject.passed == null
        ? (null, null)
        : subject.passed!
        ? ('academicResults.pass'.tr(), theme.colorScheme.primary)
        : ('academicResults.fail'.tr(), theme.colorScheme.error);
    if (label == null) return const SizedBox.shrink();
    return Text(
      label,
      style: theme.textTheme.bodySmall?.copyWith(
        color: color,
        fontWeight: FontWeight.w600,
      ),
    );
  }
}

/// A tinted, icon-led notice — used for a certificate's superseded / revoked / reissue-due
/// state.
class ResultNotice extends StatelessWidget {
  const ResultNotice({
    required this.icon,
    required this.tone,
    required this.lines,
    super.key,
  });

  final IconData icon;
  final StatusPillTone tone;
  final List<String> lines;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final semantic = Theme.of(context).extension<AppSemanticColors>()!;
    final (background, foreground) = switch (tone) {
      StatusPillTone.danger => (
        colorScheme.errorContainer,
        colorScheme.onErrorContainer,
      ),
      StatusPillTone.warning => (
        semantic.warningContainer,
        semantic.onWarningContainer,
      ),
      StatusPillTone.success => (
        colorScheme.primaryContainer,
        colorScheme.onPrimaryContainer,
      ),
      StatusPillTone.neutral => (
        colorScheme.surfaceContainerHighest,
        colorScheme.onSurfaceVariant,
      ),
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        borderRadius: AppRadius.mdRadius,
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 20, color: foreground),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final (index, line) in lines.indexed)
                    Text(
                      line,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: foreground,
                        fontWeight: index == 0 ? FontWeight.w600 : null,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
