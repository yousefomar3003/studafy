import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../student/presentation/widgets/status_pill.dart';
import '../../domain/family_finance.dart';

/// A [StatusPill] for one [ReceiptStatus] — confirmed reads as success, failed as danger, and a
/// still-pending payment stays neutral.
class ReceiptStatusPill extends StatelessWidget {
  const ReceiptStatusPill({required this.status, super.key});

  final ReceiptStatus status;

  @override
  Widget build(BuildContext context) {
    return StatusPill(label: labelKeyFor(status).tr(), tone: toneFor(status));
  }

  static String labelKeyFor(ReceiptStatus status) => switch (status) {
        ReceiptStatus.pending => 'parent.childDetail.finance.receipts.status.pending',
        ReceiptStatus.confirmed => 'parent.childDetail.finance.receipts.status.confirmed',
        ReceiptStatus.failed => 'parent.childDetail.finance.receipts.status.failed',
      };

  static StatusPillTone toneFor(ReceiptStatus status) => switch (status) {
        ReceiptStatus.pending => StatusPillTone.neutral,
        ReceiptStatus.confirmed => StatusPillTone.success,
        ReceiptStatus.failed => StatusPillTone.danger,
      };
}
