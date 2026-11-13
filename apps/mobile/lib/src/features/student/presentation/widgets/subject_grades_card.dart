import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/published_grade.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/grade_report.dart';
import 'status_pill.dart';

/// One subject's published grades: a header carrying the subject, its class code and the
/// credit-weighted average, over the category breakdown — one row per graded entry with its
/// score, percentage, weight and (where the class scheme assigns one) letter grade.
///
/// [highlighted] draws an accent border: the grades screen sets it on the subject a push deep
/// link pointed at, so the student lands looking straight at the grade that was just published.
class SubjectGradesCard extends StatelessWidget {
  const SubjectGradesCard({required this.subject, this.highlighted = false, super.key});

  final SubjectGrades subject;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final textTheme = theme.textTheme;
    final colorScheme = theme.colorScheme;

    return Card(
      shape: highlighted
          ? RoundedRectangleBorder(
              borderRadius: AppRadius.lgRadius,
              side: BorderSide(color: colorScheme.primary, width: 1.5),
            )
          : null,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        subject.courseName,
                        style: textTheme.titleMedium,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      Text(
                        subject.classCode,
                        style: textTheme.bodySmall?.copyWith(
                          color: colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: AppSpacing.space12),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      _percent(subject.weightedAverage),
                      style: textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    Text(
                      'grades.subject.weightedAverage'.tr(),
                      style: textTheme.labelSmall?.copyWith(
                        color: colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            const Divider(height: AppSpacing.space24),
            Text(
              'grades.subject.breakdown'.tr(),
              style: textTheme.labelMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.space8),
            for (final entry in subject.entries) _EntryRow(entry: entry),
          ],
        ),
      ),
    );
  }

  static String _percent(double? value) {
    if (value == null) return '—';
    final fixed = value.toStringAsFixed(1);
    return '${fixed.endsWith('.0') ? fixed.substring(0, fixed.length - 2) : fixed}%';
  }
}

class _EntryRow extends StatelessWidget {
  const _EntryRow({required this.entry});

  final PublishedGrade entry;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final score = entry.score;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(entry.label, style: textTheme.bodyMedium),
                const SizedBox(height: AppSpacing.space4),
                Wrap(
                  spacing: AppSpacing.space8,
                  runSpacing: AppSpacing.space4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    StatusPill(
                      label: 'grades.subject.entryWeight'.tr(
                        namedArgs: {'weight': _trim(entry.weight)},
                      ),
                      tone: StatusPillTone.neutral,
                    ),
                    if (entry.gradeLabel != null && entry.gradeLabel!.isNotEmpty)
                      StatusPill(label: entry.gradeLabel!, tone: StatusPillTone.success),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.space12),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                score == null
                    ? 'grades.subject.noScore'.tr()
                    : '${_trim(score)}/${_trim(entry.maxScore)}',
                style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
              ),
              if (entry.percentage != null)
                Text(
                  '${_trim(entry.percentage!)}%',
                  style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                ),
            ],
          ),
        ],
      ),
    );
  }

  /// Up to two decimals, trailing zeros dropped.
  static String _trim(num value) {
    final fixed = value.toDouble().toStringAsFixed(2);
    return fixed.contains('.') ? fixed.replaceFirst(RegExp(r'\.?0+$'), '') : fixed;
  }
}
