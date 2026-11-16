import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/kit/kit.dart';
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

    final (tone, labelKey) = switch (alert) {
      AttendanceAlert.needsAttention => (AppTone.danger, 'parent.attendance.badge.alert'),
      AttendanceAlert.watch || AttendanceAlert.onTrack => (
          AppTone.warning,
          'parent.attendance.badge.watch',
        ),
    };

    return AppStatusPill(
      label: labelKey.tr(),
      tone: tone,
      icon: Icons.warning_amber_rounded,
    );
  }
}
