import 'package:dio/dio.dart';

import '../domain/remedial_plan.dart';

/// Hand-written client for remedial plans (OpenAPI tag `Remedial plans`, 000268), shared by the
/// teacher and coordinator screens and the student and parent results screen. Failures surface as
/// the shared `ApiException` (`REMEDIAL_PLAN_DUPLICATE`, `REMEDIAL_PLAN_CLOSED`,
/// `ACADEMIC_CONFIG_LOCKED`, `VALIDATION_FAILED`, `AUTHZ_FORBIDDEN`).
class RemedialPlansClient {
  RemedialPlansClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/sections/{sectionId}/subjects/{subjectId}/remedial-plans`.
  Future<SectionRemedialPlans> fetchSection(
    String sectionId,
    String subjectId, {
    required String? termId,
  }) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/sections/$sectionId/subjects/$subjectId/remedial-plans',
      queryParameters: {'term_id': ?termId},
    );
    return SectionRemedialPlans.fromJson(response.data!);
  }

  /// `GET /api/grading/remedial-plans/{planId}`.
  Future<RemedialPlan> fetchPlan(String planId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/remedial-plans/$planId',
    );
    return RemedialPlan.fromJson(response.data!);
  }

  /// `GET /api/grading/students/{studentId}/remedial-plans`: for the student and parents, only
  /// the shared plans (without staff-only notes) while the school allows sharing.
  Future<List<RemedialPlan>> fetchStudent(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/remedial-plans',
    );
    return [
      for (final plan
          in (response.data?['plans'] as List<Object?>?) ?? const <Object?>[])
        if (plan is Map) RemedialPlan.fromJson(Map<String, Object?>.from(plan)),
    ];
  }

  /// `POST /api/grading/remedial-plans`.
  Future<RemedialPlan> create({
    required String sectionId,
    required String subjectId,
    required String studentId,
    required String? termId,
    required RemedialPlanReason reason,
    required String? reasonNote,
    required String targets,
    required String actions,
    required List<DateTime> reviewDates,
    required bool sharedWithFamily,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/grading/remedial-plans',
      data: {
        'section_id': sectionId,
        'subject_id': subjectId,
        'student_id': studentId,
        'term_id': termId,
        'reason': reason.wire,
        'reason_note': _blankToNull(reasonNote),
        'targets': targets.trim(),
        'actions': actions.trim(),
        'review_dates': [
          for (final date in reviewDates) remedialWireDate(date),
        ],
        'shared_with_family': sharedWithFamily,
      },
    );
    return RemedialPlan.fromJson(response.data!);
  }

  /// `PATCH /api/grading/remedial-plans/{planId}`: only the given fields change.
  Future<RemedialPlan> update(
    String planId, {
    RemedialPlanReason? reason,
    String? reasonNote,
    String? targets,
    String? actions,
    List<DateTime>? reviewDates,
    RemedialPlanStatus? status,
    String? statusNote,
    bool? sharedWithFamily,
  }) async {
    final response = await _dio.patch<Map<String, Object?>>(
      '/api/grading/remedial-plans/$planId',
      data: {
        'reason': ?reason?.wire,
        if (reasonNote != null) 'reason_note': _blankToNull(reasonNote),
        'targets': ?targets?.trim(),
        'actions': ?actions?.trim(),
        if (reviewDates != null)
          'review_dates': [
            for (final date in reviewDates) remedialWireDate(date),
          ],
        if (status != null) ...{
          'status': status.wire,
          'status_note': _blankToNull(statusNote),
        },
        'shared_with_family': ?sharedWithFamily,
      },
    );
    return RemedialPlan.fromJson(response.data!);
  }

  /// `POST /api/grading/remedial-plans/{planId}/notes`.
  Future<RemedialPlan> addNote(
    String planId, {
    required String body,
    required bool internal,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/grading/remedial-plans/$planId/notes',
      data: {'body': body.trim(), 'internal': internal},
    );
    return RemedialPlan.fromJson(response.data!);
  }
}

String? _blankToNull(String? value) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}
