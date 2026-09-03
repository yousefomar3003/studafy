import 'package:dio/dio.dart';

import '../domain/family_finance.dart';

/// Hand-written client for the one parent-facing finance endpoint,
/// `GET /api/finance/families/{familyId}`.
///
/// Not generated: the whole `Finance` tag is excluded from codegen (see `pubspec.yaml` —
/// swagger_parser 1.44.1 mis-resolves one of its request bodies). Same treatment, and the same
/// wiring, as `features/ai/data/*` and `features/teacher/data/grade_entry_client.dart`: its own
/// [Dio] with the base URL, bearer injection and error mapping `createApiClient` uses, built in
/// `familyFinanceClientProvider`.
///
/// Parses every array the endpoint returns — invoices, installments, receipts, and the
/// per-student and household totals. Throws the shared `ApiException` (attached by
/// `ErrorMappingInterceptor`) on any non-2xx — the endpoint can 429/503 while its ERPNext read
/// models are cold — and every screen built on this view renders that as its own error state.
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
      sections: [for (final section in students) _section(section)],
      householdTotals: _totals(body['household_totals']),
      dataAsOf: dataAsOf == null ? null : DateTime.parse(dataAsOf),
    );
  }

  FamilyStudentFinance _section(Map<String, Object?> json) => FamilyStudentFinance(
        studentId: json['student_id']! as String,
        invoices: [
          for (final entry in (json['invoices'] as List<Object?>?) ?? const [])
            FamilyInvoice.fromJson(Map<String, Object?>.from(entry! as Map)),
        ],
        installments: [
          for (final entry in (json['installments'] as List<Object?>?) ?? const [])
            FamilyInstallment.fromJson(Map<String, Object?>.from(entry! as Map)),
        ],
        receipts: [
          for (final entry in (json['payments'] as List<Object?>?) ?? const [])
            FamilyReceipt.fromJson(Map<String, Object?>.from(entry! as Map)),
        ],
        totals: _totals(json['totals']),
      );

  List<MoneyTotal> _totals(Object? raw) => [
        for (final entry in (raw as List<Object?>?) ?? const [])
          MoneyTotal.fromJson(Map<String, Object?>.from(entry! as Map)),
      ];
}
