import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/localization/localized_name.dart';
import '../../../../design/theme/app_semantic_colors.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/academic_results.dart';
import 'diploma_widgets.dart';
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

/// A place as the app's language says it: "3rd" in English, "3" in Arabic (whose sentence carries
/// the ordinal: "المرتبة 3").
String formatOrdinal(BuildContext context, int n) {
  if (context.locale.languageCode != 'en') return '$n';
  final lastTwo = n % 100;
  final suffix = lastTwo >= 11 && lastTwo <= 13
      ? 'th'
      : switch (n % 10) {
          1 => 'st',
          2 => 'nd',
          3 => 'rd',
          _ => 'th',
        };
  return '$n$suffix';
}

/// "3rd of 120"; "Not ranked" for an incomplete result; "Rank pending" while a grade-wide rank
/// waits for every section to be finalized.
String formatClassRank(BuildContext context, ClassRank rank) =>
    switch (rank.status) {
      ClassRankStatus.ranked => 'academicResults.rank.place'.tr(
        namedArgs: {
          'place': formatOrdinal(context, rank.rank!),
          'cohort': '${rank.cohortSize}',
        },
      ),
      ClassRankStatus.notRanked => 'academicResults.rank.notRanked'.tr(),
      ClassRankStatus.pending => 'academicResults.rank.pending'.tr(),
    };

/// Credits earned out of attempted ("3 / 4"); null when the result carries no credits.
String? formatCreditsEarned(num? attempted, num? earned) => attempted == null
    ? null
    : '${formatResultNumber(earned ?? 0)} / ${formatResultNumber(attempted)}';

/// The final result as the grade shows it ("16.5 / 20", "GPA 3.4 / 4"); the percentage when the
/// grade shows percentages or the result predates result formats.
String formatResultValue(ResultDisplay? display, num? percentage) {
  if (display == null || display.format == ResultFormat.percentage) {
    return formatResultPercent(percentage);
  }
  final max = formatResultNumber(display.max);
  final value = display.value;
  if (value == null) {
    return switch (display.format) {
      ResultFormat.gpa => 'academicResults.gpaUnavailable'.tr(),
      ResultFormat.pointsTotal => 'academicResults.diploma.totalPending'.tr(),
      _ => '—',
    };
  }
  return display.format == ResultFormat.gpa
      ? 'academicResults.gpaValue'.tr(
          namedArgs: {'value': formatResultNumber(value), 'max': max},
        )
      : 'academicResults.valueOutOf'.tr(
          namedArgs: {'value': formatResultNumber(value), 'max': max},
        );
}

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
              value: formatResultValue(
                overall.display,
                overall.averagePercentage,
              ),
              // The percentage stays visible beside another format.
              detail:
                  overall.display == null ||
                      overall.display!.format == ResultFormat.percentage ||
                      overall.averagePercentage == null
                  ? null
                  : formatResultPercent(overall.averagePercentage),
            ),
            // Honors/AP/HL boosts: only results that have them carry a weighted GPA.
            if (overall.weightedGpa case final weighted?)
              _Stat(
                label: 'academicResults.weightedGpa'.tr(),
                value: formatResultNumber(weighted),
              ),
            if (formatCreditsEarned(
                  overall.creditsAttempted,
                  overall.creditsEarned,
                )
                case final credits?)
              _Stat(
                label: 'academicResults.creditsEarned'.tr(),
                value: credits,
              ),
            if (overall.classRank case final rank?)
              _Stat(
                label: 'academicResults.rank.label'.tr(),
                value: formatClassRank(context, rank),
                detail: rank.percentile == null
                    ? null
                    : 'academicResults.rank.percentile'.tr(
                        namedArgs: {
                          'place': formatOrdinal(context, rank.percentile!),
                        },
                      ),
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
        if (overall.diploma case final diploma?) ...[
          const SizedBox(height: AppSpacing.space12),
          DiplomaOutcomeView(diploma: diploma),
        ],
      ],
    );
  }
}

/// Comments, conduct and attendance from a finalized report card, as frozen at finalization:
/// subject teachers' comments, conduct, days present / absent / late / excused, and the class
/// teacher's and principal's comments. Renders nothing for results and certificates from before
/// report card notes, or when the school shows none of them.
class ReportNotesSection extends StatelessWidget {
  const ReportNotesSection({
    required this.report,
    required this.subjects,
    super.key,
  });

  final ReportNotes? report;
  final List<SubjectResult> subjects;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final notes = report;
    final commented = [
      for (final subject in subjects)
        if (subject.comment != null) subject,
    ];
    final withOutcomes = [
      for (final subject in subjects)
        if (subject.outcomes.isNotEmpty) subject,
    ];
    if ((notes == null || notes.isEmpty) &&
        commented.isEmpty &&
        withOutcomes.isEmpty) {
      return const SizedBox.shrink();
    }
    final arabic = context.locale.languageCode == 'ar';
    final conduct = notes?.conductFor(context.locale.languageCode);
    final attendance = notes?.attendance;

    Widget heading(String key) => Padding(
      padding: const EdgeInsets.only(
        top: AppSpacing.space12,
        bottom: AppSpacing.space4,
      ),
      child: Text(key.tr(), style: theme.textTheme.titleSmall),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (commented.isNotEmpty) ...[
          heading('academicResults.report.subjectComments'),
          for (final subject in commented)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.space8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    context.localizedName(subject.name, subject.nameAr),
                    style: theme.textTheme.labelLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(subject.comment!, style: theme.textTheme.bodyMedium),
                ],
              ),
            ),
        ],
        if (withOutcomes.isNotEmpty) ...[
          heading('academicResults.report.outcomes'),
          for (final subject in withOutcomes)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.space8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    subject.name,
                    style: theme.textTheme.labelLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  for (final outcome in subject.outcomes)
                    Text(
                      'academicResults.report.outcomeLine'.tr(
                        namedArgs: {
                          'code': outcome.code,
                          'text':
                              (arabic ? outcome.textAr : null) ?? outcome.text,
                          'level':
                              (arabic ? outcome.labelAr : null) ??
                              outcome.label ??
                              (outcome.level == null
                                  ? '—'
                                  : '${outcome.level}'),
                        },
                      ),
                      style: theme.textTheme.bodyMedium,
                    ),
                ],
              ),
            ),
        ],
        if (conduct != null || attendance != null) ...[
          const SizedBox(height: AppSpacing.space12),
          Wrap(
            spacing: AppSpacing.space24,
            runSpacing: AppSpacing.space12,
            children: [
              if (conduct != null)
                _Stat(
                  label: 'academicResults.report.conduct'.tr(),
                  value: conduct,
                ),
              if (attendance != null) ...[
                _Stat(
                  label: 'academicResults.report.daysPresent'.tr(),
                  value: '${attendance.daysPresent}',
                ),
                _Stat(
                  label: 'academicResults.report.daysAbsent'.tr(),
                  value: '${attendance.daysAbsent}',
                ),
                _Stat(
                  label: 'academicResults.report.daysLate'.tr(),
                  value: '${attendance.daysLate}',
                ),
                _Stat(
                  label: 'academicResults.report.daysExcused'.tr(),
                  value: '${attendance.daysExcused}',
                ),
              ],
            ],
          ),
        ],
        if (notes?.teacherComment != null) ...[
          heading('academicResults.report.teacherComment'),
          Text(notes!.teacherComment!, style: theme.textTheme.bodyMedium),
        ],
        if (notes?.principalComment != null) ...[
          heading('academicResults.report.principalComment'),
          Text(notes!.principalComment!, style: theme.textTheme.bodyMedium),
        ],
      ],
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, this.detail});

  final String label;
  final String value;
  final String? detail;

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
        if (detail != null)
          Text(
            detail!,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
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
                  Text(
                    context.localizedName(subject.name, subject.nameAr),
                    style: theme.textTheme.bodyMedium,
                  ),
                  if (subject.courseLevel != null || subject.credits != null)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.space4),
                      child: Wrap(
                        spacing: AppSpacing.space8,
                        runSpacing: AppSpacing.space4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          if (subject.courseLevel case final level?)
                            StatusPill(
                              label: level,
                              tone: StatusPillTone.neutral,
                            ),
                          if (subject.credits case final credits?)
                            Text(
                              'academicResults.subjectCredits'.tr(
                                namedArgs: {
                                  'value': formatResultNumber(credits),
                                },
                              ),
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                            ),
                        ],
                      ),
                    ),
                  if (_termLine(subject) case final line?)
                    Text(
                      line,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  if (subject.isDescriptive && !subject.isExempt)
                    for (final skill in subject.skills)
                      Text(
                        'academicResults.skillLine'.tr(
                          namedArgs: {
                            'skill': skill.name,
                            'descriptor': skill.descriptor ?? '—',
                          },
                        ),
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
                subject.isExempt || subject.isDescriptive
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
                  if (!subject.isExempt && subject.weightedGpaPoints != null)
                    Text(
                      'academicResults.weightedPoints'.tr(
                        namedArgs: {
                          'value': formatResultNumber(
                            subject.weightedGpaPoints!,
                          ),
                        },
                      ),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
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
