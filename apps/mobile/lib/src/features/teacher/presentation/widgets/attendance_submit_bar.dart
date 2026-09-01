import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/attendance_taking.dart';

/// The persistent footer of the take-attendance screen: the running tally, an offline notice when
/// a submission is waiting in the outbox, and the submit action.
class AttendanceSubmitBar extends StatelessWidget {
  const AttendanceSubmitBar({
    required this.tally,
    required this.isSubmitting,
    required this.hasPendingSync,
    required this.onSubmit,
    required this.onRetrySync,
    super.key,
  });

  final AttendanceTally tally;
  final bool isSubmitting;

  /// True when this register is sitting in the outbox unsent — the submit button becomes a retry.
  final bool hasPendingSync;

  final VoidCallback onSubmit;
  final VoidCallback onRetrySync;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Material(
      elevation: 3,
      color: theme.colorScheme.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'attendance.summary'.tr(
                  namedArgs: {
                    'present': '${tally.present}',
                    'absent': '${tally.absent}',
                    'late': '${tally.late}',
                    'excused': '${tally.excused}',
                  },
                ),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              if (hasPendingSync) ...[
                const SizedBox(height: AppSpacing.space8),
                _PendingSyncNotice(onRetry: isSubmitting ? null : onRetrySync),
              ],
              const SizedBox(height: AppSpacing.space12),
              FilledButton(
                onPressed: isSubmitting ? null : onSubmit,
                child: isSubmitting
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(
                        (hasPendingSync
                                ? 'teacher.attendance.retrySubmit'
                                : 'teacher.attendance.submit')
                            .tr(),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PendingSyncNotice extends StatelessWidget {
  const _PendingSyncNotice({required this.onRetry});

  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Row(
      children: [
        Icon(Icons.cloud_off_outlined, size: 18, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(width: AppSpacing.space8),
        Expanded(
          child: Text(
            'teacher.attendance.savedOffline'.tr(),
            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ),
        if (onRetry != null)
          TextButton(onPressed: onRetry, child: Text('teacher.attendance.retrySync'.tr())),
      ],
    );
  }
}
