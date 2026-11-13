import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/attendance_record_status.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/attendance_history.dart';
import 'attendance_status_pill.dart';

/// One row in a month's absence detail: the record's date and status pill, with a secondary
/// line carrying the lateness and the teacher's reason where the record has them.
class AttendanceEntryTile extends StatelessWidget {
  const AttendanceEntryTile({required this.entry, super.key});

  final StudentAttendanceEntry entry;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final detail = _detail(context);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  DateFormat.MMMEd(context.locale.toString()).format(entry.date),
                  style: textTheme.bodyMedium,
                ),
                if (detail != null) ...[
                  const SizedBox(height: AppSpacing.space4),
                  Text(
                    detail,
                    style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.space8),
          AttendanceStatusPill(status: entry.status),
        ],
      ),
    );
  }

  /// The secondary line: "15 min late", the reason, both (joined), or nothing. An absence with
  /// no recorded reason still gets a line so the row doesn't read as an unexplained gap.
  String? _detail(BuildContext context) {
    final parts = <String>[];

    if (entry.status == AttendanceRecordStatus.valueLate && entry.minutesLate != null) {
      parts.add('attendance.lateBy'.tr(namedArgs: {'minutes': '${entry.minutesLate}'}));
    }

    final reason = entry.reason?.trim();
    if (reason != null && reason.isNotEmpty) {
      parts.add(reason);
    } else if (entry.status == AttendanceRecordStatus.absent) {
      parts.add('attendance.noReason'.tr());
    }

    return parts.isEmpty ? null : parts.join(' · ');
  }
}
