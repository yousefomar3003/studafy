import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/family_finance.dart';
import '../receipt_viewer_screen.dart';
import 'receipt_status_pill.dart';

/// One payment row in the Finance tab: the amount, the payment date, the [ReceiptStatusPill],
/// and a "View receipt" action that pushes [ReceiptViewerScreen] to view it as a PDF — disabled
/// when ERPNext supplied no receipt link, the same disabled-when-null convention
/// `AttachmentDownloadTile` uses.
class FinanceReceiptTile extends StatelessWidget {
  const FinanceReceiptTile({required this.receipt, super.key});

  final FamilyReceipt receipt;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final dateFormat = DateFormat.yMMMd(context.locale.toString());
    final canView = receipt.receiptUrl != null;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        receipt.amountLabel,
                        style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                      ),
                    ),
                    ReceiptStatusPill(status: receipt.status),
                  ],
                ),
                const SizedBox(height: AppSpacing.space4),
                Text(
                  'parent.childDetail.finance.receipts.paidOn'
                      .tr(namedArgs: {'date': dateFormat.format(receipt.paymentDate)}),
                  style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.space8),
          IconButton(
            icon: const Icon(Icons.picture_as_pdf_outlined),
            tooltip: 'parent.childDetail.finance.receipts.viewReceipt'.tr(),
            onPressed: canView
                ? () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => ReceiptViewerScreen(receipt: receipt),
                      ),
                    )
                : null,
          ),
        ],
      ),
    );
  }
}
