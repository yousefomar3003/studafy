import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/attendance_report_metrics.dart';
import '../../../../core/api/generated/models/attendance_report_trend_point.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/child_detail_providers.dart';
import '../../domain/attendance_alert.dart';
import 'attendance_alert_badge.dart';
import 'child_detail_placeholders.dart';

/// The Attendance tab of `ChildDetailScreen`: the child's term attendance totals — present,
/// absent, late and excused, each as a count and a share — with the same [AttendanceAlert] badge
/// the parent home and switcher use, over a week-by-week present-rate trend.
///
/// The child's own attendance screen (`StudentAttendanceScreen`) lists individual daily records;
/// there is no student- or parent-facing per-record endpoint, so both it and this view work from
/// the aggregate the reporting API computes. The totals here reconcile with that screen's
/// per-month summaries.
class ChildAttendanceView extends ConsumerWidget {
  const ChildAttendanceView({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final breakdown = ref.watch(childBreakdownProvider(studentId));

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(childBreakdownProvider(studentId)),
      child: breakdown.when(
        loading: () => const ChildDetailSkeleton(),
        error: (_, _) => const ChildDetailMessage(
          messageKey: 'parent.childDetail.error',
          icon: Icons.error_outline,
        ),
        data: (data) {
          final totals = data.attendance.totals;
          if (totals.totalRecords == 0) {
            return const ChildDetailMessage(
              messageKey: 'parent.childDetail.attendance.empty',
              icon: Icons.info_outline,
            );
          }
          final trends = data.attendance.trends;
          return ListView(
            padding: const EdgeInsets.all(AppSpacing.space16),
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              _TotalsCard(totals: totals),
              if (trends.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.space16),
                _TrendCard(trends: trends),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _TotalsCard extends StatelessWidget {
  const _TotalsCard({required this.totals});

  final AttendanceReportMetrics totals;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.event_available_outlined, size: 20, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Expanded(
                  child: Text(
                    'parent.childDetail.attendance.title'.tr(),
                    style: textTheme.titleMedium,
                  ),
                ),
                AttendanceAlertBadge(alert: AttendanceAlert.fromMetrics(totals)),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'parent.childDetail.attendance.recordedDays'.tr(
                namedArgs: {'count': totals.totalRecords.toString()},
              ),
              style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.space8),
            _MetricRow(
              label: 'parent.childDetail.attendance.present'.tr(),
              count: totals.presentCount,
              percent: totals.presentPercent,
            ),
            _MetricRow(
              label: 'parent.childDetail.attendance.absent'.tr(),
              count: totals.absentCount,
              percent: totals.absentPercent,
            ),
            _MetricRow(
              label: 'parent.childDetail.attendance.late'.tr(),
              count: totals.lateCount,
              percent: totals.latePercent,
            ),
            _MetricRow(
              label: 'parent.childDetail.attendance.excused'.tr(),
              count: totals.excusedCount,
              percent: totals.excusedPercent,
            ),
          ],
        ),
      ),
    );
  }
}

class _TrendCard extends StatelessWidget {
  const _TrendCard({required this.trends});

  final List<AttendanceReportTrendPoint> trends;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final weekFormat = DateFormat.MMMd(context.locale.toString());

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.show_chart, size: 20, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Text(
                  'parent.childDetail.attendance.weeklyTrend'.tr(),
                  style: textTheme.titleMedium,
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            for (final point in trends)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        'parent.childDetail.attendance.weekOf'.tr(
                          namedArgs: {'date': weekFormat.format(point.bucketStart)},
                        ),
                        style: textTheme.bodyMedium,
                      ),
                    ),
                    Text(
                      point.totalRecords == 0
                          ? '—'
                          : 'parent.childDetail.attendance.presentShare'.tr(
                              namedArgs: {'percent': point.presentPercent.round().toString()},
                            ),
                      style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _MetricRow extends StatelessWidget {
  const _MetricRow({required this.label, required this.count, required this.percent});

  final String label;
  final int count;
  final num percent;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        children: [
          Expanded(child: Text(label, style: textTheme.bodyMedium)),
          Text(
            'parent.childDetail.attendance.countShare'.tr(
              namedArgs: {'count': count.toString(), 'percent': percent.round().toString()},
            ),
            style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}
