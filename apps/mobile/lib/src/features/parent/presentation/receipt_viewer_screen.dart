import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_pdfview/flutter_pdfview.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/receipt_viewer_providers.dart';
import '../domain/family_finance.dart';

/// In-app PDF view of one payment receipt, downloaded fresh via [receiptFileProvider] — the same
/// download-then-[PDFView] shape `MaterialViewerScreen` uses for course materials, without that
/// screen's on-device cache: a receipt is opened rarely enough that persisting it isn't worth the
/// machinery. See [FamilyReceipt.receiptUrl]'s doc comment for the one way this can legitimately
/// fail to download.
class ReceiptViewerScreen extends ConsumerWidget {
  const ReceiptViewerScreen({required this.receipt, super.key});

  final FamilyReceipt receipt;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final url = receipt.receiptUrl;

    return Scaffold(
      appBar: AppBar(title: Text('parent.childDetail.finance.receipts.viewer.title'.tr())),
      body: url == null
          ? const _ReceiptUnavailable()
          : _ReceiptPdf(receiptUrl: url),
    );
  }
}

class _ReceiptUnavailable extends StatelessWidget {
  const _ReceiptUnavailable();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.receipt_long_outlined, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'parent.childDetail.finance.receipts.unavailable'.tr(),
              textAlign: TextAlign.center,
              style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

class _ReceiptPdf extends ConsumerWidget {
  const _ReceiptPdf({required this.receiptUrl});

  final String receiptUrl;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final fileAsync = ref.watch(receiptFileProvider(receiptUrl));
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return fileAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, stackTrace) => Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.error_outline, size: 32, color: colorScheme.error),
              const SizedBox(height: AppSpacing.space8),
              Text(
                'parent.childDetail.finance.receipts.viewer.downloadError'.tr(),
                textAlign: TextAlign.center,
                style: textTheme.bodyMedium,
              ),
              const SizedBox(height: AppSpacing.space12),
              OutlinedButton(
                onPressed: () => ref.invalidate(receiptFileProvider(receiptUrl)),
                child: Text('parent.childDetail.finance.receipts.viewer.retry'.tr()),
              ),
            ],
          ),
        ),
      ),
      data: (file) => PDFView(filePath: file.path),
    );
  }
}
