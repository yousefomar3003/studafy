import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/attendance_providers.dart';
import '../domain/attendance_history.dart';
import 'widgets/attendance_month_section.dart';

/// The student's personal attendance history: one card per month, newest first, each with a
/// present/absent/late/excused summary and the detail of every non-present day.
///
/// Served entirely from [attendanceHistoryProvider]; until a student-facing attendance endpoint
/// exists (see [studentAttendanceRecordsProvider]) the real app shows the "not available yet"
/// state, and the populated states are exercised by overriding that seam.
class StudentAttendanceScreen extends ConsumerWidget {
  const StudentAttendanceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(attendanceHistoryProvider);

    return Scaffold(
      appBar: AppBar(title: Text('attendance.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(studentAttendanceRecordsProvider),
        child: status.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, stackTrace) => const _ScrollableMessage(
            icon: Icons.error_outline,
            messageKey: 'attendance.error',
          ),
          data: (state) => switch (state) {
            AttendanceHistoryUnavailable() => const _ScrollableMessage(
              icon: Icons.info_outline,
              messageKey: 'attendance.unavailable',
            ),
            AttendanceHistoryReady(:final history) when history.isEmpty =>
              const _ScrollableMessage(
                icon: Icons.event_available_outlined,
                messageKey: 'attendance.empty',
              ),
            AttendanceHistoryReady(:final history) => ListView.separated(
              padding: const EdgeInsets.all(AppSpacing.space16),
              physics: const AlwaysScrollableScrollPhysics(),
              itemCount: history.months.length,
              separatorBuilder: (context, index) =>
                  const SizedBox(height: AppSpacing.space16),
              itemBuilder: (context, index) =>
                  AttendanceMonthSection(month: history.months[index]),
            ),
          },
        ),
      ),
    );
  }
}

/// A centered icon+message filling the screen, wrapped in a scrollable so pull-to-refresh keeps
/// working on the unavailable, empty and errored states — the same shape the assignments list
/// uses (`assignments_screen.dart`).
class _ScrollableMessage extends StatelessWidget {
  const _ScrollableMessage({required this.icon, required this.messageKey});

  final IconData icon;
  final String messageKey;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.space32),
      children: [
        Column(
          children: [
            Icon(icon, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              messageKey.tr(),
              textAlign: TextAlign.center,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ],
    );
  }
}
