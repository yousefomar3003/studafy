import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/presentation/widgets/status_pill.dart';
import '../../domain/mark_sheet.dart';

/// A [StatusPill] for one period's mark-sheet status: draft neutral, awaiting approval a
/// warning, returned a danger (it needs the teacher), approved a success.
class MarkPeriodStatusPill extends StatelessWidget {
  const MarkPeriodStatusPill({required this.status, super.key});

  final MarkSheetPeriodStatus status;

  @override
  Widget build(BuildContext context) => StatusPill(
    label: 'teacher.marks.status.${status.name}'.tr(),
    tone: switch (status) {
      MarkSheetPeriodStatus.draft => StatusPillTone.neutral,
      MarkSheetPeriodStatus.submitted => StatusPillTone.warning,
      MarkSheetPeriodStatus.approved => StatusPillTone.success,
      MarkSheetPeriodStatus.returned => StatusPillTone.danger,
      MarkSheetPeriodStatus.unknown => StatusPillTone.warning,
    },
  );
}

/// A period's display name: its term's name, or "Annual" for the year-level period.
String markPeriodLabel(MarkSheet sheet, String? termId) =>
    sheet.termById(termId)?.name ?? 'teacher.marks.period.annual'.tr();

/// Up to two decimals, trailing zeros dropped — "92", "87.5", "66.67".
String formatMarkNumber(num value) {
  final fixed = value.toDouble().toStringAsFixed(2);
  return fixed.contains('.')
      ? fixed.replaceFirst(RegExp(r'\.?0+$'), '')
      : fixed;
}

/// The translated message for a failed grading write, by the problem's `code`.
String markErrorMessage(Object error) {
  final code = error is DioException ? error.apiError?.code : null;
  return switch (code) {
    'MARKS_LOCKED' => 'teacher.marks.errors.locked',
    'MARK_SCORE_OUT_OF_RANGE' => 'teacher.marks.errors.outOfRange',
    'GRADE_CONCURRENT_EDIT' => 'teacher.marks.errors.conflict',
    'ACADEMIC_YEAR_NOT_ACTIVE' => 'teacher.marks.errors.yearNotActive',
    'AUTHZ_FORBIDDEN' => 'teacher.marks.errors.forbidden',
    _ => 'teacher.marks.errors.generic',
  }.tr();
}

/// The problem `code` of a failed request, or null for a network-level failure.
String? markErrorCode(Object error) =>
    error is DioException ? error.apiError?.code : null;

/// Centered icon + message (+ optional retry), scrollable so it works inside a
/// [RefreshIndicator].
class MarksMessage extends StatelessWidget {
  const MarksMessage({
    required this.icon,
    required this.message,
    this.onRetry,
    super.key,
  });

  final IconData icon;
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.space32),
      children: [
        Icon(icon, size: 32, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(height: AppSpacing.space12),
        Text(
          message,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        if (onRetry != null) ...[
          const SizedBox(height: AppSpacing.space12),
          Center(
            child: OutlinedButton(
              onPressed: onRetry,
              child: Text('teacher.marks.retry'.tr()),
            ),
          ),
        ],
      ],
    );
  }
}
