import 'package:dio/dio.dart';

import '../domain/academic_equivalency.dart';

/// Hand-written client for a student's Tawjihi equivalency estimate (OpenAPI tag
/// `Tawjihi equivalency`) and multi-year results (tag `Multi-year results`), shared by the
/// student's own results screen and a parent viewing a linked child. Students and parents get only
/// what the school shows them; the apps only read.
class AcademicEquivalencyClient {
  AcademicEquivalencyClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/students/{studentId}/equivalency`.
  Future<List<EquivalencyEstimate>> fetchEquivalency(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/equivalency',
    );
    return parseStudentEquivalency(response.data);
  }

  /// `GET /api/grading/students/{studentId}/multi-year-results`.
  Future<List<MultiYearResult>> fetchMultiYearResults(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/multi-year-results',
    );
    return parseStudentMultiYearResults(response.data);
  }
}
