import 'package:dio/dio.dart';

import '../domain/exam_entries.dart';

/// Hand-written client for a student's exam entries (OpenAPI tag `Exam entries`), shared by the
/// student's own results screen and a parent viewing a linked child. The API serves school
/// leadership, the student's teachers, the student, or a linked parent; the apps only read.
class ExamEntriesClient {
  ExamEntriesClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/students/{studentId}/external-exam-entries` — latest session first.
  Future<List<StudentExamEntry>> fetchEntries(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/external-exam-entries',
    );
    return parseStudentExamEntries(response.data);
  }
}
