import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/family_finance.dart';
import 'installment_status_pill.dart';

/// One fee-schedule installment row in the Finance tab: its due date, outstanding vs. total, and
/// the [InstallmentStatusPill] ERPNext's own fee-schedule sync computed server-side.
class FinanceInstallmentTile extends StatelessWidget {
  const FinanceInstallmentTile({required this.installment, super.key});

  final FamilyInstallment installment;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final dateFormat = DateFormat.yMMMd(context.locale.toString());

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'parent.childDetail.finance.installments.due'
                      .tr(namedArgs: {'date': dateFormat.format(installment.dueDate)}),
                  style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              InstallmentStatusPill(status: installment.status),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),
          Text(
            installment.status == InstallmentStatus.paid
                ? 'parent.childDetail.finance.installments.totalPaid'
                    .tr(namedArgs: {'amount': installment.totalLabel})
                : 'parent.childDetail.finance.installments.outstandingOfTotal'.tr(namedArgs: {
                    'outstanding': installment.outstandingLabel,
                    'total': installment.totalLabel,
                  }),
            style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
