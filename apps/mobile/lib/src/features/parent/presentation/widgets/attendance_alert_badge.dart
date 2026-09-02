import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/attendance_alert.dart';

/// A small pill stating where a child's term attendance stands. Rendered only when the alert is
/// [AttendanceAlert.isElevated] — an on-track child gets no badge, so the switcher and the
/// attendance card stay quiet until there is something to see.
class AttendanceAlertBadge extends StatelessWidget {
  const AttendanceAlertBadge({required this.alert, super.key});

  final AttendanceAlert alert;

  @override
  Widget build(BuildContext context) {
    if (!alert.isElevated) return const SizedBox.shrink();

    final colorScheme = Theme.of(context).colorScheme;
    final (background, foreground, labelKey) = switch (alert) {
      AttendanceAlert.needsAttention => (
          colorScheme.errorContainer,
          colorScheme.onErrorContainer,
          'parent.attendance.badge.alert',
        ),
      AttendanceAlert.watch || AttendanceAlert.onTrack => (
          colorScheme.secondaryContainer,
          colorScheme.onSecondaryContainer,
          'parent.attendance.badge.watch',
        ),
    };

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space8,
        vertical: AppSpacing.space4,
      ),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        labelKey.tr(),
        style: Theme.of(context)
            .textTheme
            .labelSmall
            ?.copyWith(color: foreground, fontWeight: FontWeight.w600),
      ),
    );
  }
}
