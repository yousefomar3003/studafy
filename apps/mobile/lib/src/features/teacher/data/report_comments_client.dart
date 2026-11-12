import 'package:dio/dio.dart';

import '../domain/report_comments.dart';

/// Report card comments for one subject (OpenAPI tag `Results`, 000209). On its own [Dio] like
/// [MarkSheetClient]; failures surface as the shared `ApiException` (`RESULTS_ALREADY_FINALIZED`,
/// `ACADEMIC_YEAR_NOT_ACTIVE`, `AUTHZ_FORBIDDEN`).
class ReportCommentsClient {
  ReportCommentsClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/sections/{sectionId}/report-notes`, narrowed to [subjectId].
  Future<SubjectReportComments> fetch(
    String sectionId,
    String subjectId, {
    required String? termId,
  }) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/sections/$sectionId/report-notes',
      queryParameters: {'term_id': ?termId},
    );
    return SubjectReportComments.fromJson(response.data!, subjectId);
  }

  /// `PUT .../subjects/{subjectId}/report-comments`. A blank comment clears it.
  Future<SubjectReportComments> save(
    String sectionId,
    String subjectId, {
    required String? termId,
    required Map<String, String> comments,
  }) async {
    final response = await _dio.put<Map<String, Object?>>(
      '/api/grading/sections/$sectionId/subjects/$subjectId/report-comments',
      data: {
        'term_id': termId,
        'comments': [
          for (final entry in comments.entries)
            {
              'student_id': entry.key,
              'comment': entry.value.trim().isEmpty ? null : entry.value.trim(),
            },
        ],
      },
    );
    return SubjectReportComments.fromJson(response.data!, subjectId);
  }
}
