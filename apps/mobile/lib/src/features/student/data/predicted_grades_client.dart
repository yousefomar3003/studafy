import 'package:dio/dio.dart';

import '../domain/predicted_grades.dart';

/// Hand-written client for a student's predicted grades (OpenAPI tag `Results`, 000254), shared
/// by the student's own results screen and a parent viewing a linked child.
class StudentPredictedGradesClient {
  StudentPredictedGradesClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/students/{studentId}/predicted-grades`: only the years the school shows to
  /// students and parents, without notes.
  Future<List<PredictedGradesYear>> fetch(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/predicted-grades',
    );
    return parsePredictedGradeYears(response.data);
  }
}
