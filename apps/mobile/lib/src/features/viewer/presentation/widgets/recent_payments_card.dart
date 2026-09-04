import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/viewer_providers.dart';
import '../../domain/finance_payment.dart';
import 'viewer_section_card.dart';

String _modeLabel(FinancePaymentMode mode) => switch (mode) {
  FinancePaymentMode.cash => 'viewer.finance.payments.mode.cash'.tr(),
  FinancePaymentMode.bankTransfer => 'viewer.finance.payments.mode.bankTransfer'.tr(),
  FinancePaymentMode.cardExternal => 'viewer.finance.payments.mode.cardExternal'.tr(),
  FinancePaymentMode.unknown => 'viewer.finance.payments.mode.unknown'.tr(),
};

String _statusLabel(FinancePaymentStatus status) => switch (status) {
  FinancePaymentStatus.pending => 'viewer.finance.payments.status.pending'.tr(),
  FinancePaymentStatus.confirmed => 'viewer.finance.payments.status.confirmed'.tr(),
  FinancePaymentStatus.failed => 'viewer.finance.payments.status.failed'.tr(),
  FinancePaymentStatus.unknown => 'viewer.finance.payments.status.unknown'.tr(),
};

/// The school's most recently recorded payments — amount, mode, date, and confirmation status.
/// From the local payment read-model (`GET /api/finance/payments`), not an ERPNext report: a
/// plain list of what was recorded, matching `RecentPaymentsFeedTile` on web.
class RecentPaymentsCard extends ConsumerWidget {
  const RecentPaymentsCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final payments = ref.watch(viewerRecentPaymentsProvider);
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return ViewerSectionCard(
      titleKey: 'viewer.finance.payments.title',
      icon: Icons.payments_outlined,
      child: payments.when(
        loading: () => const ViewerCardSkeleton(),
        error: (error, stackTrace) => const ViewerCardMessage(
          messageKey: 'viewer.finance.payments.error',
          icon: Icons.error_outline,
        ),
        data: (items) {
          if (items.isEmpty) {
            return const ViewerCardMessage(
              messageKey: 'viewer.finance.payments.empty',
              icon: Icons.info_outline,
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final payment in items) ...[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${payment.amount} ${payment.currency}', style: textTheme.bodyLarge),
                          Text(
                            '${_modeLabel(payment.paymentMode)} · ${payment.paymentDate}',
                            style: textTheme.bodySmall?.copyWith(
                              color: colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Text(
                      _statusLabel(payment.status),
                      style: textTheme.labelMedium?.copyWith(color: colorScheme.onSurfaceVariant),
                    ),
                  ],
                ),
                if (payment != items.last) const SizedBox(height: AppSpacing.space8),
              ],
            ],
          );
        },
      ),
    );
  }
}
