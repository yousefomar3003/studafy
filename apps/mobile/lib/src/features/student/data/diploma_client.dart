import 'package:dio/dio.dart';

import '../domain/diploma_prediction.dart';

/// Hand-written client for a student's IB Diploma prediction (OpenAPI tag `Results`, 000263),
/// shared by the student's own results screen and a parent viewing a linked child.
class StudentDiplomaClient {
  StudentDiplomaClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/students/{studentId}/diploma`: the years with a predicted total.
  Future<List<DiplomaPredictionYear>> fetch(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/diploma',
    );
    return parseDiplomaPredictions(response.data);
  }
}
