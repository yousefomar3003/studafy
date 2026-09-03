import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// A bare [Dio] for fetching a receipt PDF's bytes.
///
/// Deliberately not `apiClientProvider`'s: `receipt_url` (see `FamilyReceipt.receiptUrl`'s doc
/// comment in `domain/family_finance.dart`) points at ERPNext, not the Studafy API, and carries
/// no bearer-token requirement of its own — the same reasoning `materialBytesDioProvider`
/// (`core/offline/material_file_cache.dart`) uses for pre-signed object-storage downloads.
final receiptBytesDioProvider = Provider<Dio>((ref) => Dio());

/// Downloads [receiptUrl] to a fresh temp file for in-app PDF viewing.
///
/// Re-downloads on every open rather than caching on disk: unlike course materials, a receipt is
/// opened rarely and its bytes are small, so the persistent, drift-backed cache
/// `MaterialFileCache` uses would be machinery this feature doesn't earn. A bare-path
/// `receipt_url` (no configured ERPNext origin behind it — see the doc comment this parameter
/// name points at) fails here with a [DioException] that resolves to this provider's own
/// [AsyncError], which `ReceiptViewerScreen` renders as its normal error/retry state.
final receiptFileProvider =
    FutureProvider.autoDispose.family<File, String>((ref, receiptUrl) async {
  final dio = ref.watch(receiptBytesDioProvider);
  final response = await dio.get<List<int>>(
    receiptUrl,
    options: Options(responseType: ResponseType.bytes),
  );

  final tempDir = await getTemporaryDirectory();
  final fileName = 'receipt-${receiptUrl.hashCode.toRadixString(16)}.pdf';
  final file = File(p.join(tempDir.path, fileName));
  return file.writeAsBytes(response.data!, flush: true);
});
