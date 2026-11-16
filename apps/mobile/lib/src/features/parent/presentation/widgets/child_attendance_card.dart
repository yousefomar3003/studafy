import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/child_comparison_item.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/attendance_alert.dart';
import 'attendance_alert_badge.dart';
import 'parent_section_card.dart';

/// The selected child's term attendance: a present/absent summary line, with an alert badge in
/// the header once absences pass the [AttendanceAlert] thresholds.
class ChildAttendanceCard extends StatelessWidget {
  const ChildAttendanceCard({required this.child, super.key});

  final ChildComparisonItem child;

  @override
  Widget build(BuildContext context) {
    final metrics = child.attendance;
    final alert = AttendanceAlert.fromMetrics(metrics);

    return ParentSectionCard(
      titleKey: 'parent.attendance.title',
      icon: Icons.event_available_outlined,
      accent: AppAccent.emerald,
      trailing: AttendanceAlertBadge(alert: alert),
      child: metrics.totalRecords == 0
          ? const ParentCardMessage(
              messageKey: 'parent.attendance.empty',
              icon: Icons.info_outline,
            )
          : _AttendanceMeter(
              presentPercent: metrics.presentPercent,
              summary: 'parent.attendance.summary'.tr(namedArgs: {
                'present': metrics.presentPercent.round().toString(),
                'absent': metrics.absentCount.toString(),
              }),
              tone: alert.isElevated
                  ? (alert == AttendanceAlert.needsAttention ? AppTone.danger : AppTone.warning)
                  : AppTone.success,
            ),
    );
  }
}

/// The summary line over a present-rate bar, tinted by the alert level. The line already says
/// the percentage, so the bar is hidden from screen readers.
class _AttendanceMeter extends StatelessWidget {
  const _AttendanceMeter({
    required this.presentPercent,
    required this.summary,
    required this.tone,
  });

  final num presentPercent;
  final String summary;
  final AppTone tone;

  @override
  Widget build(BuildContext context) {
    final colors = tone.colorsOf(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          summary,
          style: Theme.of(context).textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w500),
        ),
        const SizedBox(height: AppSpacing.space12),
        ExcludeSemantics(
          child: ClipRRect(
            borderRadius: AppRadius.fullRadius,
            child: LinearProgressIndicator(
              value: (presentPercent / 100).clamp(0, 1).toDouble(),
              minHeight: 8,
              color: colors.solid,
              backgroundColor: colors.container,
            ),
          ),
        ),
      ],
    );
  }
}
