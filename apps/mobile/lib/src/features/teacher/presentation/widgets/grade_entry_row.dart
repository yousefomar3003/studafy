import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/grade_entry.dart';
import 'grade_status_chip.dart';

/// One student's row on the per-assessment entry screen.
///
/// While the submission is a draft the score box is the tap target that binds the docked keypad
/// to this row; [isFocused] highlights the bound row and [isOutOfRange] flags a value past the
/// assessment maximum inline (it is never saved). Once the submission is submitted/approved the
/// row is read-only: the recorded score and a [GradeStatusChip] instead of an input.
class GradeEntryRow extends StatelessWidget {
  const GradeEntryRow({
    required this.studentLabel,
    required this.scoreText,
    required this.maxScore,
    required this.status,
    required this.isFocused,
    required this.isOutOfRange,
    required this.isDirty,
    required this.onTap,
    super.key,
  });

  final String studentLabel;
  final String scoreText;
  final double maxScore;
  final GradeSubmissionStatus status;
  final bool isFocused;
  final bool isOutOfRange;
  final bool isDirty;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final locked = status.isLocked;
    final maxLabel = _trimNumber(maxScore);

    return InkWell(
      onTap: locked ? null : onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          vertical: AppSpacing.space12,
          horizontal: AppSpacing.space4,
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(studentLabel, style: theme.textTheme.bodyMedium, maxLines: 1),
                  if (isOutOfRange)
                    Text(
                      'teacher.grades.entry.overMax'.tr(namedArgs: {'max': maxLabel}),
                      style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error),
                    )
                  else if (status.isRejected)
                    Text(
                      'teacher.grades.entry.rejectedHint'.tr(),
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                    ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.space12),
            if (locked)
              GradeStatusChip(status: status)
            else
              _ScoreBox(
                text: scoreText,
                maxLabel: maxLabel,
                isFocused: isFocused,
                isOutOfRange: isOutOfRange,
                isDirty: isDirty,
              ),
          ],
        ),
      ),
    );
  }

  static String _trimNumber(double value) =>
      value == value.roundToDouble() ? value.toInt().toString() : value.toString();
}

class _ScoreBox extends StatelessWidget {
  const _ScoreBox({
    required this.text,
    required this.maxLabel,
    required this.isFocused,
    required this.isOutOfRange,
    required this.isDirty,
  });

  final String text;
  final String maxLabel;
  final bool isFocused;
  final bool isOutOfRange;
  final bool isDirty;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final Color border;
    if (isOutOfRange) {
      border = theme.colorScheme.error;
    } else if (isFocused) {
      border = theme.colorScheme.primary;
    } else {
      border = theme.colorScheme.outlineVariant;
    }

    return Container(
      constraints: const BoxConstraints(minWidth: 84),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space12,
        vertical: AppSpacing.space8,
      ),
      decoration: BoxDecoration(
        borderRadius: AppRadius.mdRadius,
        border: Border.all(color: border, width: isFocused || isOutOfRange ? 2 : 1),
        color: isFocused ? theme.colorScheme.primaryContainer.withValues(alpha: 0.25) : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            text.isEmpty ? '—' : text,
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w600,
              color: text.isEmpty ? theme.colorScheme.onSurfaceVariant : null,
            ),
          ),
          Text(
            ' / $maxLabel',
            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
