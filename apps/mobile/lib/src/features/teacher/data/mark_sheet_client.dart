import 'package:dio/dio.dart';

import '../domain/mark_sheet.dart';

/// Hand-written client for the teacher side of the academic grading API (OpenAPI tag `Marks`).
///
/// The generated `MarksClient` covers the same paths, but its roster model cannot parse an exempt
/// student (see the doc comment on `domain/mark_sheet.dart`), so — like `GradeEntryClient` — this
/// talks to the endpoints directly on its own [Dio], wired by `markSheetClientProvider` with the
/// same base URL, bearer injection and error mapping as `createApiClient`.
///
/// Every method throws the shared `ApiException` (attached by `ErrorMappingInterceptor`) on a
/// non-2xx; callers branch on `apiError.code`: `MARKS_LOCKED`, `MARK_SCORE_OUT_OF_RANGE`,
/// `GRADE_CONCURRENT_EDIT`, `ACADEMIC_YEAR_NOT_ACTIVE`, `RESULTS_INCOMPLETE`, `AUTHZ_FORBIDDEN`.
class MarkSheetClient {
  MarkSheetClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/my-assignments` — the sections and subjects the signed-in teacher grades,
  /// for [academicYearId] or the latest active year.
  Future<List<GradingAssignment>> listMyAssignments({
    String? academicYearId,
  }) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/my-assignments',
      queryParameters: {'academic_year_id': ?academicYearId},
    );
    return [
      for (final row
          in (response.data?['assignments'] as List<Object?>?) ??
              const <Object?>[])
        GradingAssignment.fromJson(Map<String, Object?>.from(row! as Map)),
    ];
  }

  /// `GET /api/grading/sections/{sectionId}/subjects/{subjectId}/marks`.
  Future<MarkSheet> fetchMarkSheet(String sectionId, String subjectId) async {
    final response = await _dio.get<Map<String, Object?>>(
      _sheetPath(sectionId, subjectId),
    );
    return MarkSheet.fromJson(response.data!);
  }

  /// `PUT .../marks` — record, change or clear (status `pending`) up to 500 marks atomically.
  /// Returns the refreshed sheet, previews included.
  Future<MarkSheet> saveMarks(
    String sectionId,
    String subjectId,
    List<MarkEntryInput> entries,
  ) async {
    final response = await _dio.put<Map<String, Object?>>(
      _sheetPath(sectionId, subjectId),
      data: {
        'entries': [for (final entry in entries) entry.toJson()],
      },
    );
    return MarkSheet.fromJson(
      Map<String, Object?>.from(response.data!['sheet']! as Map),
    );
  }

  /// `POST .../assessments` — add an assessment for this section. Returns its status: `active`,
  /// or `proposed` when the subject requires approval of teacher-added assessments.
  Future<String> addAssessment(
    String sectionId,
    String subjectId, {
    required String categoryId,
    required String? termId,
    required String name,
    required double maxMarks,
    double weight = 1,
    bool isMandatory = true,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/grading/sections/$sectionId/subjects/$subjectId/assessments',
      data: {
        'category_id': categoryId,
        'term_id': termId,
        'name': name,
        'max_marks': maxMarks,
        'weight': weight,
        'is_mandatory': isMandatory,
      },
    );
    return response.data?['status'] as String? ?? 'active';
  }

  /// `POST .../mark-sheets/submit` — submit one period (`termId` null = annual) for approval.
  /// Returns the period's new status (`submitted`, or `approved` when the grade needs no
  /// approval step).
  Future<MarkSheetPeriodStatus> submitPeriod(
    String sectionId,
    String subjectId, {
    required String? termId,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/grading/sections/$sectionId/subjects/$subjectId/mark-sheets/submit',
      data: {'term_id': termId},
    );
    return MarkSheetPeriodStatus.fromWire(response.data?['status']);
  }

  static String _sheetPath(String sectionId, String subjectId) =>
      '/api/grading/sections/$sectionId/subjects/$subjectId/marks';
}
