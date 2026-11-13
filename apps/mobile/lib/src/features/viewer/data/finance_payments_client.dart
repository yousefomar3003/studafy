import 'package:dio/dio.dart';

import '../domain/finance_payment.dart';

/// Hand-written client for the one finance endpoint the viewer shell reads,
/// `GET /api/finance/payments`.
///
/// Not generated: the whole `Finance` tag is excluded from codegen (see `pubspec.yaml`). Same
/// treatment, and the same wiring, as `features/parent/data/family_finance_client.dart` and
/// `features/teacher/data/grade_entry_client.dart`: its own [Dio] with the base URL, bearer
/// injection and error mapping `createApiClient` uses, built in `financePaymentsClientProvider`.
///
/// Deliberately just this one endpoint. The org-wide finance reports (`ar-aging`,
/// `collections-vs-due`) return ERPNext's raw report shape — `columns`/`rows` the web dashboard
/// parses with ~150 lines of column-matching logic (`apps/web/src/features/finance/queries.ts`)
/// — which is its own scope, not a viewer summary. Payments are a plain read-model list with no
/// such parsing, the same reason `RecentPaymentsFeedTile` reads them differently from its sibling
/// report tiles.
class FinancePaymentsClient {
  FinancePaymentsClient(this._dio);

  final Dio _dio;

  Future<List<FinancePayment>> listRecent({int limit = 5}) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/finance/payments',
      queryParameters: {'limit': limit, 'offset': 0},
    );
    final body = response.data!;
    final payments = (body['payments'] as List<Object?>?) ?? const [];

    return [
      for (final entry in payments)
        FinancePayment.fromJson(Map<String, Object?>.from(entry! as Map)),
    ];
  }
}
