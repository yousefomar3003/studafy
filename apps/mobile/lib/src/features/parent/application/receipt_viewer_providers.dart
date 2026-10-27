import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../../../core/auth/authenticated_dio.dart';

/// The [Dio] a receipt PDF is fetched with: rooted at the Studafy API and carrying the session's
/// bearer token, through the same interceptors as every API call (see [authenticatedDio]).
///
/// `receipt_url` (see `FamilyReceipt.receiptUrl`'s doc comment in `domain/family_finance.dart`) is
/// the API's own receipt endpoint, a path relative to the API origin that only answers an
/// authenticated guardian of the paying student, so a bare [Dio] could neither resolve nor
/// authorize it.
final receiptBytesDioProvider = Provider<Dio>(authenticatedDio);

/// One receipt to download: its `receipt_url`, and the app language the PDF should be in (the API
/// renders the receipt's labels in the request's Accept-Language).
typedef ReceiptRequest = ({String receiptUrl, String languageCode});

/// Downloads a receipt to a fresh temp file for in-app PDF viewing.
///
/// Re-downloads on every open rather than caching on disk: unlike course materials, a receipt is
/// opened rarely and its bytes are small, so the persistent, drift-backed cache
/// `MaterialFileCache` uses would be machinery this feature doesn't earn. A failed download
/// resolves to this provider's own [AsyncError], which `ReceiptViewerScreen` renders as its normal
/// error/retry state.
final receiptFileProvider =
    FutureProvider.autoDispose.family<File, ReceiptRequest>((ref, request) async {
  final dio = ref.watch(receiptBytesDioProvider);
  final response = await dio.get<List<int>>(
    request.receiptUrl,
    options: Options(
      responseType: ResponseType.bytes,
      headers: {'Accept-Language': request.languageCode},
    ),
  );

  final tempDir = await getTemporaryDirectory();
  final fileName =
      'receipt-${request.receiptUrl.hashCode.toRadixString(16)}-${request.languageCode}.pdf';
  final file = File(p.join(tempDir.path, fileName));
  return file.writeAsBytes(response.data!, flush: true);
});
