import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../student/presentation/widgets/status_pill.dart';
import '../../domain/family_finance.dart';

/// A [StatusPill] for one [InstallmentStatus] — paid reads as success, overdue as danger,
/// partially paid as a warning, and a still-pending installment stays neutral.
class InstallmentStatusPill extends StatelessWidget {
  const InstallmentStatusPill({required this.status, super.key});

  final InstallmentStatus status;

  @override
  Widget build(BuildContext context) {
    return StatusPill(label: labelKeyFor(status).tr(), tone: toneFor(status));
  }

  static String labelKeyFor(InstallmentStatus status) => switch (status) {
        InstallmentStatus.pending => 'parent.childDetail.finance.installments.status.pending',
        InstallmentStatus.partiallyPaid =>
          'parent.childDetail.finance.installments.status.partiallyPaid',
        InstallmentStatus.paid => 'parent.childDetail.finance.installments.status.paid',
        InstallmentStatus.overdue => 'parent.childDetail.finance.installments.status.overdue',
      };

  static StatusPillTone toneFor(InstallmentStatus status) => switch (status) {
        InstallmentStatus.pending => StatusPillTone.neutral,
        InstallmentStatus.partiallyPaid => StatusPillTone.warning,
        InstallmentStatus.paid => StatusPillTone.success,
        InstallmentStatus.overdue => StatusPillTone.danger,
      };
}
