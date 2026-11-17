import 'package:dio/dio.dart';

import '../domain/student_ai_offer.dart';

/// The two parent Student AI endpoints: the offer per child (`GET /api/parent/student-ai`) and
/// opting a child in (`POST /api/parent/student-ai/opt-ins`).
///
/// Hand-written on the app's authenticated [Dio] (bearer, 401 recovery, error mapping), like
/// [FamilyFinanceClient]: the generated `LicensingClient.getParentStudentAi` parses into models
/// that treat nullable fields as required (see [StudentAiOffers]). Errors come back as a
/// `DioException` carrying the API's `ApiException`; branch on its `code`.
class StudentAiClient {
  StudentAiClient(this._dio);

  final Dio _dio;

  Future<StudentAiOffers> fetchOffers() async {
    final response = await _dio.get<Map<String, Object?>>('/api/parent/student-ai');
    return StudentAiOffers.fromJson(response.data!);
  }

  /// Opts [studentId] in. [termsVersion] is the one the offers came with and [expectedTotalMinor]
  /// the total the parent was shown: the API refuses with 409 `AI_OPTIN_PRICE_CHANGED` when the
  /// price moved since. Committed for the school year: there is no undo.
  Future<StudentAiOptIn> optIn({
    required String studentId,
    required String termsVersion,
    required int expectedTotalMinor,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/parent/student-ai/opt-ins',
      data: {
        'studentId': studentId,
        'acceptTerms': true,
        'termsVersion': termsVersion,
        'expectedTotalMinor': expectedTotalMinor,
      },
    );
    return StudentAiOptIn.fromJson(response.data!);
  }
}
