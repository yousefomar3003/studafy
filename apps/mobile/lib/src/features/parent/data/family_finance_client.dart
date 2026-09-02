import 'package:dio/dio.dart';

import '../domain/child_fees.dart';

/// Hand-written client for the one parent-facing finance endpoint,
/// `GET /api/finance/families/{familyId}`.
///
/// Not generated: the whole `Finance` tag is excluded from codegen (see `pubspec.yaml` —
/// swagger_parser 1.44.1 mis-resolves one of its request bodies). Same treatment, and the same
/// wiring, as `features/ai/data/*` and `features/teacher/data/grade_entry_client.dart`: its own
/// [Dio] with the base URL, bearer injection and error mapping `createApiClient` uses, built in
/// `familyFinanceClientProvider`.
///
/// Only the outstanding-balance projection is parsed. Throws the shared `ApiException` (attached
/// by `ErrorMappingInterceptor`) on any non-2xx — the endpoint can 429/503 while its ERPNext
/// read models are cold — and the fees card renders that as its own error state.
class FamilyFinanceClient {
  FamilyFinanceClient(this._dio);

  final Dio _dio;

  Future<FamilyFinanceView> fetch(String familyId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/finance/families/$familyId',
    );
    final body = response.data!;

    final students = ((body['students'] as List<Object?>?) ?? const [])
        .map((e) => Map<String, Object?>.from(e! as Map));
    final dataAsOf = body['data_as_of'] as String?;

    return FamilyFinanceView(
      outstandingByStudentId: {
        for (final section in students)
          section['student_id']! as String: _totals(section['totals']),
      },
      householdTotals: _totals(body['household_totals']),
      dataAsOf: dataAsOf == null ? null : DateTime.parse(dataAsOf),
    );
  }

  List<MoneyTotal> _totals(Object? raw) => [
        for (final entry in (raw as List<Object?>?) ?? const [])
          MoneyTotal.fromJson(Map<String, Object?>.from(entry! as Map)),
      ];
}
