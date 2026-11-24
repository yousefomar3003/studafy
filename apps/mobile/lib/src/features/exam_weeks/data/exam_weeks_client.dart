import 'package:dio/dio.dart';

import '../domain/exam_weeks.dart';

/// Hand-written client for exam weeks (OpenAPI tag `Exam weeks`): a student's exam timetable,
/// shared by the student and a parent viewing a linked child, and the signed-in teacher's
/// invigilation duties. The apps only read; the API shows published exam periods only.
class ExamWeeksClient {
  ExamWeeksClient(this._dio);

  final Dio _dio;

  /// `GET /api/academics/students/{studentId}/exam-timetable`.
  Future<StudentExamTimetable> fetchStudentTimetable(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/academics/students/$studentId/exam-timetable',
    );
    return StudentExamTimetable.fromJson(response.data);
  }

  /// `GET /api/academics/me/invigilation-duties`.
  Future<InvigilationDuties> fetchMyDuties() async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/academics/me/invigilation-duties',
    );
    return InvigilationDuties.fromJson(response.data);
  }
}
