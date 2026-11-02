import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/presentation/widgets/status_pill.dart';
import '../../domain/family_finance.dart';

/// One invoice row in the Finance tab: its own document name, issue/due dates, total vs.
/// outstanding, a settled/overdue/due pill, and — only while money is still owed and the school
/// has a payment redirect configured — the "Pay on website" deep link.
///
/// Read-only per architecture: this app never records a payment. Tapping "Pay on website" hands
/// the invoice off to [FamilyInvoice.payOnlineUrl] — the school's own payment frontend, primed
/// with this invoice and student as query context (`buildPayOnlineUrl` in
/// `finance/family/service.ts`) — via the OS browser, the same `launchUrl(...,
/// mode: externalApplication)` pattern `AttachmentDownloadTile` uses.
class FinanceInvoiceTile extends StatelessWidget {
  const FinanceInvoiceTile({required this.invoice, super.key});

  final FamilyInvoice invoice;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final dateFormat = DateFormat.yMMMd(context.locale.toString());
    final dueDate = invoice.dueDate;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  invoice.erpnextDocname,
                  style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              StatusPill(label: _statusLabel(invoice).tr(), tone: _statusTone(invoice)),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),
          Text(
            dueDate == null
                ? 'parent.childDetail.finance.invoices.issued'
                    .tr(namedArgs: {'date': dateFormat.format(invoice.issuedDate)})
                : 'parent.childDetail.finance.invoices.issuedAndDue'.tr(namedArgs: {
                    'issued': dateFormat.format(invoice.issuedDate),
                    'due': dateFormat.format(dueDate),
                  }),
            style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: AppSpacing.space4),
          Text(
            invoice.isSettled
                ? 'parent.childDetail.finance.invoices.totalPaid'
                    .tr(namedArgs: {'amount': invoice.totalLabel})
                : 'parent.childDetail.finance.invoices.outstandingOfTotal'.tr(namedArgs: {
                    'outstanding': invoice.outstandingLabel,
                    'total': invoice.totalLabel,
                  }),
            style: textTheme.bodyMedium,
          ),
          if (invoice.payOnlineUrl case final payUrl?) ...[
            const SizedBox(height: AppSpacing.space8),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: OutlinedButton.icon(
                onPressed: () => launchUrl(Uri.parse(payUrl), mode: LaunchMode.externalApplication),
                icon: const Icon(Icons.open_in_new, size: 18),
                label: Text('parent.childDetail.finance.invoices.payOnline'.tr()),
              ),
            ),
          ],
        ],
      ),
    );
  }

  static String _statusLabel(FamilyInvoice invoice) => invoice.isSettled
      ? 'parent.childDetail.finance.invoices.paid'
      : invoice.isOverdue
          ? 'parent.childDetail.finance.invoices.overdue'
          : 'parent.childDetail.finance.invoices.due';

  static StatusPillTone _statusTone(FamilyInvoice invoice) => invoice.isSettled
      ? StatusPillTone.success
      : invoice.isOverdue
          ? StatusPillTone.danger
          : StatusPillTone.warning;
}
