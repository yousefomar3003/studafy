import 'package:dio/dio.dart';

import '../domain/predicted_grades.dart';

/// Predicted grades for one section and subject (OpenAPI tag `Results`, 000254). On its own [Dio]
/// like [ReportCommentsClient]; failures surface as the shared `ApiException`
/// (`PREDICTED_GRADES_DISABLED`, `ACADEMIC_CONFIG_LOCKED`, `VALIDATION_FAILED`, `AUTHZ_FORBIDDEN`).
class PredictedGradesClient {
  PredictedGradesClient(this._dio);

  final Dio _dio;

  /// The grade section and subject a class is taught to, from the class and its course; null when
  /// the class is not linked to a section. Read as raw JSON so it does not depend on which fields
  /// the generated models keep.
  Future<({String sectionId, String subjectId})?> classTarget(
    String classId,
  ) async {
    final klass = await _dio.get<Map<String, Object?>>(
      '/api/academics/classes/$classId',
    );
    final sectionId = klass.data?['section_id'];
    final courseId = klass.data?['course_id'];
    if (sectionId is! String || courseId is! String) return null;
    final course = await _dio.get<Map<String, Object?>>(
      '/api/academics/courses/$courseId',
    );
    final subjectId = course.data?['subject_id'];
    if (subjectId is! String) return null;
    return (sectionId: sectionId, subjectId: subjectId);
  }

  /// `GET .../sections/{sectionId}/subjects/{subjectId}/predicted-grades`.
  Future<SectionPredictedGrades> fetch(
    String sectionId,
    String subjectId, {
    required String? termId,
  }) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/sections/$sectionId/subjects/$subjectId/predicted-grades',
      queryParameters: {'term_id': ?termId},
    );
    return SectionPredictedGrades.fromJson(response.data!);
  }

  /// `PUT` the same path. A null or blank label removes that student's prediction; notes are left
  /// as they are (they are written on the web).
  Future<SectionPredictedGrades> save(
    String sectionId,
    String subjectId, {
    required String? termId,
    required Map<String, String?> grades,
  }) async {
    final response = await _dio.put<Map<String, Object?>>(
      '/api/grading/sections/$sectionId/subjects/$subjectId/predicted-grades',
      data: {
        'term_id': termId,
        'grades': [
          for (final entry in grades.entries)
            {
              'student_id': entry.key,
              'grade_label': (entry.value?.trim().isEmpty ?? true)
                  ? null
                  : entry.value!.trim(),
            },
        ],
      },
    );
    return SectionPredictedGrades.fromJson(response.data!);
  }
}
