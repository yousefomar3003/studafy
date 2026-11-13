import 'package:dio/dio.dart';

import '../domain/student_overview.dart';

/// The teacher's student page (OpenAPI `getClassStudentOverview`). On its own [Dio] like
/// [ReportCommentsClient]; failures surface as the shared `ApiException` (`AUTHZ_FORBIDDEN` when
/// the teacher no longer teaches the class, `RESOURCE_NOT_FOUND` when the student left it).
class StudentOverviewClient {
  StudentOverviewClient(this._dio);

  final Dio _dio;

  /// `GET /api/academics/classes/{classId}/students/{studentId}/overview`.
  Future<StudentOverview> fetch(String classId, String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/academics/classes/$classId/students/$studentId/overview',
    );
    return StudentOverview.fromJson(response.data!);
  }
}
