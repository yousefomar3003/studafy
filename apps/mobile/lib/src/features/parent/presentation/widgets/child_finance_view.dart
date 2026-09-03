import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/parent_providers.dart';
import '../../domain/family_finance.dart';
import 'child_detail_placeholders.dart';
import 'finance_installment_tile.dart';
import 'finance_invoice_tile.dart';
import 'finance_receipt_tile.dart';

/// The Finance tab of `ChildDetailScreen`: the selected child's balance, invoices,
/// fee-schedule installments and payment receipts, drawn from the same household
/// [familyFinanceProvider] the parent home's `ChildFeesCard` watches — so a finance-service
/// outage (the endpoint can 429/503) shows here with its own retry, never blanking the other
/// tabs. Read-only per architecture: nothing on this tab writes anything back.
class ChildFinanceView extends ConsumerWidget {
  const ChildFinanceView({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final finance = ref.watch(familyFinanceProvider);

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(familyFinanceProvider),
      child: finance.when(
        loading: () => const ChildDetailSkeleton(),
        error: (_, _) => const ChildDetailMessage(
          messageKey: 'parent.childDetail.finance.error',
          icon: Icons.error_outline,
        ),
        data: (view) {
          final section = view?.sectionFor(studentId);
          if (view == null || section == null || section.isEmpty) {
            return const ChildDetailMessage(
              messageKey: 'parent.childDetail.finance.empty',
              icon: Icons.info_outline,
            );
          }
          return ListView(
            padding: const EdgeInsets.all(AppSpacing.space16),
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              _BalanceCard(totals: section.totals, dataAsOf: view.dataAsOf),
              const SizedBox(height: AppSpacing.space16),
              _FinanceSection(
                titleKey: 'parent.childDetail.finance.invoices.title',
                emptyKey: 'parent.childDetail.finance.invoices.empty',
                icon: Icons.receipt_outlined,
                itemCount: section.invoices.length,
                itemBuilder: (context, i) => FinanceInvoiceTile(invoice: section.invoices[i]),
              ),
              const SizedBox(height: AppSpacing.space16),
              _FinanceSection(
                titleKey: 'parent.childDetail.finance.installments.title',
                emptyKey: 'parent.childDetail.finance.installments.empty',
                icon: Icons.event_repeat_outlined,
                itemCount: section.installments.length,
                itemBuilder: (context, i) =>
                    FinanceInstallmentTile(installment: section.installments[i]),
              ),
              const SizedBox(height: AppSpacing.space16),
              _FinanceSection(
                titleKey: 'parent.childDetail.finance.receipts.title',
                emptyKey: 'parent.childDetail.finance.receipts.empty',
                icon: Icons.payments_outlined,
                itemCount: section.receipts.length,
                itemBuilder: (context, i) => FinanceReceiptTile(receipt: section.receipts[i]),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.totals, required this.dataAsOf});

  final List<MoneyTotal> totals;
  final DateTime? dataAsOf;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final due = [for (final total in totals) if (total.owesMoney) total];

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.account_balance_wallet_outlined, size: 20, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Text('parent.childDetail.finance.balance.title'.tr(), style: textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            if (due.isEmpty)
              Text(
                'parent.childDetail.finance.balance.settled'.tr(),
                style: textTheme.bodyMedium,
              )
            else
              for (final total in due)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
                  child: Text(
                    'parent.childDetail.finance.balance.due'.tr(namedArgs: {'amount': total.label}),
                    style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
            if (dataAsOf case final asOf?) ...[
              const SizedBox(height: AppSpacing.space4),
              Text(
                'parent.childDetail.finance.balance.asOf'.tr(namedArgs: {
                  'date': MaterialLocalizations.of(context).formatMediumDate(asOf.toLocal()),
                }),
                style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _FinanceSection extends StatelessWidget {
  const _FinanceSection({
    required this.titleKey,
    required this.emptyKey,
    required this.icon,
    required this.itemCount,
    required this.itemBuilder,
  });

  final String titleKey;
  final String emptyKey;
  final IconData icon;
  final int itemCount;
  final Widget Function(BuildContext, int) itemBuilder;

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
                Icon(icon, size: 20, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Text(titleKey.tr(), style: textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: AppSpacing.space8),
            if (itemCount == 0)
              Text(
                emptyKey.tr(),
                style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
              )
            else
              for (var i = 0; i < itemCount; i++) ...[
                if (i > 0) const Divider(height: AppSpacing.space16),
                itemBuilder(context, i),
              ],
          ],
        ),
      ),
    );
  }
}
