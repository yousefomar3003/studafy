import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/grade_entry_providers.dart';

/// Persistent footer of the grade-entry screen: the autosave indicator on the left, and the
/// "submit for approval" action on the right. Submitting is a gradebook-level action — it locks
/// every draft student that has at least one score — so [submittableCount] is how many that is.
class GradeSubmitBar extends StatelessWidget {
  const GradeSubmitBar({
    required this.saveStatus,
    required this.lastSavedAt,
    required this.errorCode,
    required this.submittableCount,
    required this.isSubmitting,
    required this.onSubmit,
    required this.onRetrySave,
    super.key,
  });

  final GradeSaveStatus saveStatus;
  final DateTime? lastSavedAt;
  final String? errorCode;
  final int submittableCount;
  final bool isSubmitting;
  final VoidCallback onSubmit;
  final VoidCallback onRetrySave;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final canSubmit = submittableCount > 0 && !isSubmitting && saveStatus != GradeSaveStatus.saving;

    return Material(
      elevation: 3,
      color: theme.colorScheme.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: Row(
            children: [
              Expanded(child: _SaveIndicator(
                status: saveStatus,
                lastSavedAt: lastSavedAt,
                errorCode: errorCode,
                onRetry: onRetrySave,
              )),
              const SizedBox(width: AppSpacing.space12),
              FilledButton(
                onPressed: canSubmit ? onSubmit : null,
                child: isSubmitting
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(
                        'teacher.grades.entry.submitCount'
                            .tr(namedArgs: {'count': '$submittableCount'}),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SaveIndicator extends StatelessWidget {
  const _SaveIndicator({
    required this.status,
    required this.lastSavedAt,
    required this.errorCode,
    required this.onRetry,
  });

  final GradeSaveStatus status;
  final DateTime? lastSavedAt;
  final String? errorCode;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);

    switch (status) {
      case GradeSaveStatus.saving:
        return Row(
          children: [
            const SizedBox.square(dimension: 12, child: CircularProgressIndicator(strokeWidth: 2)),
            const SizedBox(width: AppSpacing.space8),
            Text('teacher.grades.entry.saving'.tr(), style: muted),
          ],
        );
      case GradeSaveStatus.pending:
        return Text('teacher.grades.entry.unsaved'.tr(), style: muted);
      case GradeSaveStatus.error:
        return Row(
          children: [
            Icon(Icons.error_outline, size: 16, color: theme.colorScheme.error),
            const SizedBox(width: AppSpacing.space4),
            Flexible(
              child: Text(
                (errorCode == 'GRADE_CONCURRENT_EDIT'
                        ? 'teacher.grades.entry.saveConflict'
                        : 'teacher.grades.entry.saveFailed')
                    .tr(),
                style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error),
              ),
            ),
            TextButton(onPressed: onRetry, child: Text('teacher.grades.entry.retry'.tr())),
          ],
        );
      case GradeSaveStatus.saved:
        final savedText = lastSavedAt == null
            ? 'teacher.grades.entry.allSaved'.tr()
            : 'teacher.grades.entry.savedAt'
                .tr(namedArgs: {'time': DateFormat.Hm().format(lastSavedAt!)});
        return Row(
          children: [
            Icon(Icons.cloud_done_outlined, size: 16, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.space4),
            Flexible(child: Text(savedText, style: muted)),
          ],
        );
      case GradeSaveStatus.idle:
        return Text('teacher.grades.entry.autosaveHint'.tr(), style: muted);
    }
  }
}
