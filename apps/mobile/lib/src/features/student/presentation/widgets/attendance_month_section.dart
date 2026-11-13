import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/attendance_history.dart';
import 'attendance_entry_tile.dart';

/// One month's card on the attendance screen: the month name and attendance rate, a
/// present/absent/late/excused summary line, then a row per non-present day — or a
/// full-attendance note when the month has none.
class AttendanceMonthSection extends StatelessWidget {
  const AttendanceMonthSection({required this.month, super.key});

  final AttendanceMonth month;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final exceptions = month.exceptions;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  DateFormat.yMMMM(context.locale.toString()).format(month.month),
                  style: textTheme.titleMedium,
                ),
                Text(
                  'attendance.rate'.tr(
                    namedArgs: {'percent': '${(month.attendanceRate * 100).round()}'},
                  ),
                  style: textTheme.titleMedium?.copyWith(color: colorScheme.primary),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space4),
            Text(
              'attendance.summary'.tr(
                namedArgs: {
                  'present': '${month.presentCount}',
                  'absent': '${month.absentCount}',
                  'late': '${month.lateCount}',
                  'excused': '${month.excusedCount}',
                },
              ),
              style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
            if (exceptions.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.space12),
                child: Text(
                  'attendance.noAbsences'.tr(),
                  style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
                ),
              )
            else
              for (final entry in exceptions) ...[
                const Divider(height: AppSpacing.space24),
                AttendanceEntryTile(entry: entry),
              ],
          ],
        ),
      ),
    );
  }
}
