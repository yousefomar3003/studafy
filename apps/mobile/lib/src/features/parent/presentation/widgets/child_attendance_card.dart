import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/child_comparison_item.dart';
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
      trailing: AttendanceAlertBadge(alert: alert),
      child: metrics.totalRecords == 0
          ? const ParentCardMessage(
              messageKey: 'parent.attendance.empty',
              icon: Icons.info_outline,
            )
          : Text(
              'parent.attendance.summary'.tr(namedArgs: {
                'present': metrics.presentPercent.round().toString(),
                'absent': metrics.absentCount.toString(),
              }),
              style: Theme.of(context).textTheme.bodyMedium,
            ),
    );
  }
}
