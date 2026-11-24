import 'package:dio/dio.dart';

import '../domain/academic_plans.dart';

/// Learning outcome achievement and lesson and term plans (OpenAPI tags `Learning outcomes` and
/// `Lesson plans`, 000268). On its own [Dio] like `PredictedGradesClient`; failures surface as the
/// shared `ApiException` (`RESULTS_ALREADY_FINALIZED`, `CONFLICT_STATE_MISMATCH`,
/// `CONFLICT_DUPLICATE_ENTRY`, `VALIDATION_FAILED`, `AUTHZ_FORBIDDEN`).
class AcademicPlansClient {
  AcademicPlansClient(this._dio);

  final Dio _dio;

  String _sectionSubject(String sectionId, String subjectId) =>
      '/api/grading/sections/$sectionId/subjects/$subjectId';

  Future<SectionOutcomeAchievements> fetchAchievements(
    String sectionId,
    String subjectId, {
    required String? termId,
  }) async {
    final response = await _dio.get<Map<String, Object?>>(
      '${_sectionSubject(sectionId, subjectId)}/outcome-achievements',
      queryParameters: {'term_id': ?termId},
    );
    return SectionOutcomeAchievements.fromJson(response.data!);
  }

  /// Saves changed levels, keyed by `(studentId, outcomeId)`; a null level clears it.
  Future<SectionOutcomeAchievements> saveAchievements(
    String sectionId,
    String subjectId, {
    required String? termId,
    required Map<(String, String), int?> levels,
  }) async {
    final response = await _dio.put<Map<String, Object?>>(
      '${_sectionSubject(sectionId, subjectId)}/outcome-achievements',
      data: {
        'term_id': termId,
        'achievements': [
          for (final entry in levels.entries)
            {
              'student_id': entry.key.$1,
              'outcome_id': entry.key.$2,
              'level': entry.value,
            },
        ],
      },
    );
    return SectionOutcomeAchievements.fromJson(response.data!);
  }

  Future<List<PlanSummary>> listPlans(
    PlanKind kind,
    String sectionId,
    String subjectId,
  ) async {
    final response = await _dio.get<Map<String, Object?>>(
      '${_sectionSubject(sectionId, subjectId)}/${_segment(kind)}',
    );
    return [
      for (final plan
          in (response.data?['plans'] as List<Object?>?) ?? const <Object?>[])
        if (plan is Map) PlanSummary.fromJson(kind, Map.from(plan)),
    ];
  }

  Future<TermPlan> fetchTermPlan(String planId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/term-plans/$planId',
    );
    return TermPlan.fromJson(response.data!);
  }

  Future<LessonPlan> fetchLessonPlan(String planId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/lesson-plans/$planId',
    );
    return LessonPlan.fromJson(response.data!);
  }

  /// Creates a draft (no [planId]) or replaces a draft or returned plan's notes and weeks.
  Future<TermPlan> saveTermPlan({
    required String sectionId,
    required String subjectId,
    required String? planId,
    required String termId,
    required String? notes,
    required List<TermPlanWeek> weeks,
  }) async {
    final body = {
      'notes': notes,
      'weeks': [for (final week in weeks) week.toJson()],
    };
    final response = planId == null
        ? await _dio.post<Map<String, Object?>>(
            '${_sectionSubject(sectionId, subjectId)}/term-plans',
            data: {'term_id': termId, ...body},
          )
        : await _dio.put<Map<String, Object?>>(
            '/api/grading/term-plans/$planId',
            data: body,
          );
    return TermPlan.fromJson(response.data!);
  }

  /// Creates a draft (no [planId]) or replaces a draft or returned lesson plan.
  Future<LessonPlan> saveLessonPlan({
    required String sectionId,
    required String subjectId,
    required String? planId,
    required Map<String, Object?> body,
  }) async {
    final response = planId == null
        ? await _dio.post<Map<String, Object?>>(
            '${_sectionSubject(sectionId, subjectId)}/lesson-plans',
            data: body,
          )
        : await _dio.put<Map<String, Object?>>(
            '/api/grading/lesson-plans/$planId',
            data: body,
          );
    return LessonPlan.fromJson(response.data!);
  }

  Future<LessonPlan> saveReflection(String planId, String? reflection) async {
    final response = await _dio.put<Map<String, Object?>>(
      '/api/grading/lesson-plans/$planId/reflection',
      data: {'reflection': reflection},
    );
    return LessonPlan.fromJson(response.data!);
  }

  Future<void> submit(PlanKind kind, String planId) =>
      _dio.post<Object?>('/api/grading/${_segment(kind)}/$planId/submit');

  Future<void> delete(PlanKind kind, String planId) =>
      _dio.delete<Object?>('/api/grading/${_segment(kind)}/$planId');

  /// Approves (`approve`) or returns (`return`, with a [comment]) a submitted plan.
  Future<void> review(
    PlanKind kind,
    String planId, {
    required bool approve,
    String? comment,
  }) => _dio.post<Object?>(
    '/api/grading/${_segment(kind)}/$planId/review',
    data: {'decision': approve ? 'approve' : 'return', 'comment': comment},
  );

  Future<LessonPlanOptions> lessonOptions(
    String sectionId,
    String subjectId, {
    required String? date,
  }) async {
    final response = await _dio.get<Map<String, Object?>>(
      '${_sectionSubject(sectionId, subjectId)}/lesson-plan-options',
      queryParameters: {'date': ?date},
    );
    return LessonPlanOptions.fromJson(response.data!);
  }

  /// The plans awaiting the caller's review this year.
  Future<PlanReviewQueue> reviewQueue() async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/plan-reviews',
    );
    return PlanReviewQueue.fromJson(response.data ?? const {});
  }

  String _segment(PlanKind kind) =>
      kind == PlanKind.term ? 'term-plans' : 'lesson-plans';
}
