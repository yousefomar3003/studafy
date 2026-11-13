import 'package:dio/dio.dart';

import '../domain/academic_results.dart';

/// Hand-written client for a student's finalized results and certificates (OpenAPI tag
/// `Results`), shared by the student's own screen and a parent viewing a linked child. The API
/// scopes every call: school leadership, the student themself, or a linked parent.
///
/// Not the generated `ResultsClient`, for the reason given on `domain/academic_results.dart`;
/// wired on [authenticatedDio] by `academicResultsClientProvider`.
class AcademicResultsClient {
  AcademicResultsClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/students/{studentId}/results` — finalized, current versions only.
  Future<List<FinalizedResult>> fetchResults(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/results',
    );
    return [
      for (final row
          in (response.data?['results'] as List<Object?>?) ?? const <Object?>[])
        FinalizedResult.fromJson(Map<String, Object?>.from(row! as Map)),
    ];
  }

  /// `GET /api/grading/students/{studentId}/certificates` — every certificate and report card,
  /// superseded and revoked ones included.
  Future<List<AcademicCertificate>> fetchCertificates(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/certificates',
    );
    return _certificates(response.data);
  }

  /// `GET /api/grading/certificates/{certificateId}` — one document exactly as issued.
  Future<AcademicCertificate> fetchCertificate(String certificateId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/certificates/$certificateId',
    );
    return AcademicCertificate.fromJson(response.data!);
  }

  static List<AcademicCertificate> _certificates(Map<String, Object?>? body) =>
      [
        for (final row
            in (body?['certificates'] as List<Object?>?) ?? const <Object?>[])
          AcademicCertificate.fromJson(Map<String, Object?>.from(row! as Map)),
      ];
}
