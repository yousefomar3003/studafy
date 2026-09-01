import 'package:dio/dio.dart';

import '../domain/grade_entry.dart';

/// Hand-written client for the `Grade Entry` / `Grade Workflow` API surface.
///
/// Not generated: both tags are excluded from codegen (see `pubspec.yaml`) because
/// swagger_parser 1.44.1 mis-generates the `Grade` schema, so `GradebookEntryList` can't be
/// deserialised by the generated client. Same treatment as `features/ai/data/*`. Wired on its
/// own [Dio] — identical base URL, bearer injection and error mapping as `createApiClient` —
/// through `gradeEntryClientProvider`.
///
/// Every method returns a parsed domain object and throws the shared `ApiException` (attached by
/// `ErrorMappingInterceptor`) on any non-2xx; callers branch on `apiError.code`
/// (`GRADE_SCORE_EXCEEDS_MAX`, `GRADE_CONCURRENT_EDIT`, `GRADE_INVALID_STATUS_TRANSITION`).
class GradeEntryClient {
  GradeEntryClient(this._dio);

  final Dio _dio;

  /// `GET /api/grades/gradebooks?classId=` — the class's gradebook, created empty on first
  /// access. Every other call here needs the id it returns.
  Future<GradebookRef> resolveGradebook(String classId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grades/gradebooks',
      queryParameters: {'classId': classId},
    );
    return GradebookRef.fromJson(response.data!);
  }

  /// `GET /api/grades/gradebooks/{id}/entry` — the full entry grid (one submission per enrolled
  /// student, each with its assessment cells).
  Future<List<GradeSubmission>> fetchEntry(String gradebookId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grades/gradebooks/$gradebookId/entry',
    );
    return _submissionsOf(response.data!);
  }

  /// `POST /api/grades/gradebooks/{id}/assessments` — add an assessment (label + max score +
  /// weight) across every draft submission. Returns the refreshed grid.
  Future<List<GradeSubmission>> createAssessment(
    String gradebookId, {
    required String label,
    required double maxScore,
    double weight = 1,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/grades/gradebooks/$gradebookId/assessments',
      data: {'label': label, 'max_score': maxScore, 'weight': weight},
    );
    return _submissionsOf(response.data!);
  }

  /// `PATCH /api/grades/gradebooks/{id}/grades` — atomically write up to 100 score cells. Each
  /// [GradeScoreEdit] carries the `updated_at` token from the last read; a stale token fails the
  /// whole batch with 409. Returns the updated cells (in input order) so callers can refresh
  /// their concurrency tokens without a full refetch.
  Future<List<GradeCell>> bulkUpdateGrades(
    String gradebookId,
    List<GradeScoreEdit> edits,
  ) async {
    if (edits.isEmpty) return const [];
    final response = await _dio.patch<List<Object?>>(
      '/api/grades/gradebooks/$gradebookId/grades',
      data: {
        'grades': [
          for (final edit in edits)
            {'id': edit.gradeId, 'score': edit.score, 'updated_at': edit.updatedAt},
        ],
      },
    );
    return (response.data ?? const [])
        .map((e) => GradeCell.fromJson(Map<String, Object?>.from(e! as Map)))
        .toList(growable: false);
  }

  /// `PATCH /api/grades/gradebooks/{id}/submissions/{submissionId}/submit` — draft → submitted.
  /// Locks every cell on that submission. [updatedAt] is the submission row's token.
  Future<GradeSubmission> submitSubmission(
    String gradebookId,
    String submissionId, {
    required String updatedAt,
  }) async {
    final response = await _dio.patch<Map<String, Object?>>(
      '/api/grades/gradebooks/$gradebookId/submissions/$submissionId/submit',
      data: {'updated_at': updatedAt},
    );
    return GradeSubmission.fromJson(response.data!);
  }

  List<GradeSubmission> _submissionsOf(Map<String, Object?> body) =>
      ((body['submissions'] as List<Object?>?) ?? const [])
          .map((e) => GradeSubmission.fromJson(Map<String, Object?>.from(e! as Map)))
          .toList(growable: false);
}

/// One cell change in a `bulkUpdateGrades` batch. [score] is null to ungrade.
class GradeScoreEdit {
  const GradeScoreEdit({
    required this.gradeId,
    required this.score,
    required this.updatedAt,
  });

  final String gradeId;
  final double? score;
  final String updatedAt;
}
