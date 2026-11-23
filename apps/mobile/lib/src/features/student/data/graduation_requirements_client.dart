import 'package:dio/dio.dart';

import '../domain/graduation_requirements.dart';

/// Hand-written client for a student's graduation requirements checklist (OpenAPI tag
/// `Graduation requirements`), shared by the student's own results screen and a parent viewing a
/// linked child. Students and parents get only the sets the school shows them; the apps only read.
class GraduationRequirementsClient {
  GraduationRequirementsClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/students/{studentId}/graduation-requirements`.
  Future<List<GraduationSetChecklist>> fetchChecklist(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/graduation-requirements',
    );
    return parseGraduationChecklist(response.data);
  }
}
