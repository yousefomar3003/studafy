import 'package:dio/dio.dart';

import '../domain/external_exam_results.dart';

/// Hand-written client for a student's external exam results and test scores (OpenAPI tag
/// `External exams`), shared by the student's own results screen and a parent viewing a linked
/// child. The API serves school leadership, the student's teachers, the student, or a linked
/// parent; the apps only read.
class ExternalExamResultsClient {
  ExternalExamResultsClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/students/{studentId}/external-exam-results` — newest sitting first.
  Future<List<ExternalExamResult>> fetchResults(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/external-exam-results',
    );
    return parseExternalExamResults(response.data);
  }
}
