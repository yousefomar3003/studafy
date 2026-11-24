import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../design/kit/kit.dart';
import '../../domain/remedial_plan.dart';

/// A plan's status as a pill: open info, in progress warning, achieved success, closed neutral.
/// An unknown status (a newer server) reads as a neutral "Updated".
class RemedialStatusPill extends StatelessWidget {
  const RemedialStatusPill({required this.status, super.key});

  final RemedialPlanStatus status;

  @override
  Widget build(BuildContext context) => AppStatusPill(
    label: remedialStatusLabel(status),
    tone: switch (status) {
      RemedialPlanStatus.open => AppTone.info,
      RemedialPlanStatus.inProgress => AppTone.warning,
      RemedialPlanStatus.achieved => AppTone.success,
      RemedialPlanStatus.closed ||
      RemedialPlanStatus.unknown => AppTone.neutral,
    },
  );
}

String remedialStatusLabel(RemedialPlanStatus status) =>
    'remedial.status.${status.name}'.tr();

String remedialReasonLabel(RemedialPlanReason reason) => switch (reason) {
  RemedialPlanReason.belowPass => 'remedial.reason.belowPass'.tr(),
  _ => 'remedial.reason.teacherConcern'.tr(),
};

/// "Term 1" or "Whole year".
String remedialPeriodLabel(String? termName) =>
    termName ?? 'remedial.wholeYear'.tr();

/// A calendar date in the app's language ("12 Nov 2026").
String remedialDate(BuildContext context, DateTime date) =>
    DateFormat.yMMMd(context.locale.toString()).format(date);

/// Up to two decimals, trailing zeros dropped, with a percent sign.
String remedialPercent(double value) {
  final fixed = value.toStringAsFixed(2);
  final trimmed = fixed.contains('.')
      ? fixed.replaceFirst(RegExp(r'\.?0+$'), '')
      : fixed;
  return '$trimmed%';
}

/// The translated message for a failed remedial plan request, by the problem's `code`.
String remedialErrorMessage(Object error) {
  final code = error is DioException ? error.apiError?.code : null;
  return switch (code) {
    'REMEDIAL_PLAN_DUPLICATE' => 'remedial.errors.duplicate',
    'REMEDIAL_PLAN_CLOSED' => 'remedial.errors.closed',
    'ACADEMIC_CONFIG_LOCKED' => 'remedial.errors.locked',
    'VALIDATION_FAILED' => 'remedial.errors.invalid',
    'AUTHZ_FORBIDDEN' || 'ACCESS_DENIED' => 'remedial.errors.forbidden',
    _ => 'remedial.errors.generic',
  }.tr();
}

/// One plan as a card: the student (or subject, for a family), period, status and next review.
class RemedialPlanCard extends StatelessWidget {
  const RemedialPlanCard({
    required this.plan,
    required this.onTap,
    this.showStudent = true,
    super.key,
  });

  final RemedialPlanSummary plan;
  final VoidCallback onTap;

  /// Staff lists lead with the student; a family's list with the subject.
  final bool showStudent;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final next = plan.nextReviewOn;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        onTap: onTap,
        title: Text(showStudent ? plan.studentName : plan.subjectName),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              [
                if (!showStudent) plan.sectionLabel,
                remedialPeriodLabel(plan.termName),
                remedialReasonLabel(plan.reason),
              ].where((part) => part.isNotEmpty).join(' · '),
              style: muted,
            ),
            if (next != null)
              Text(
                'remedial.nextReview'.tr(
                  namedArgs: {'date': remedialDate(context, next)},
                ),
                style: plan.overdue
                    ? muted?.copyWith(color: theme.colorScheme.error)
                    : muted,
              ),
          ],
        ),
        trailing: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            RemedialStatusPill(status: plan.status),
            if (plan.overdue) ...[
              const SizedBox(height: 4),
              AppStatusPill(
                label: 'remedial.overdue'.tr(),
                tone: AppTone.danger,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
