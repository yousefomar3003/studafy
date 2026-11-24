import 'package:dio/dio.dart';

import '../domain/diploma_core.dart';

/// IB Diploma core grades for one section (OpenAPI tag `Results`, 000263). On its own [Dio] like
/// [PredictedGradesClient]; failures surface as the shared `ApiException` (`DIPLOMA_TOTAL_DISABLED`,
/// `PREDICTED_GRADES_DISABLED`, `ACADEMIC_CONFIG_LOCKED`, `AUTHZ_FORBIDDEN`).
class DiplomaCoreClient {
  DiplomaCoreClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/sections/{sectionId}/diploma-core`.
  Future<SectionDiplomaCore> fetch(String sectionId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/sections/$sectionId/diploma-core',
    );
    return SectionDiplomaCore.fromJson(response.data!);
  }

  /// `PUT` the same path: one kind of grades for the students given. All three empty removes a
  /// student's row of that kind.
  Future<SectionDiplomaCore> save(
    String sectionId, {
    required DiplomaCoreKind kind,
    required Map<String, DiplomaCoreValues> grades,
  }) async {
    final response = await _dio.put<Map<String, Object?>>(
      '/api/grading/sections/$sectionId/diploma-core',
      data: {
        'kind': kind.wire,
        'grades': [
          for (final entry in grades.entries) entry.value.toJson(entry.key),
        ],
      },
    );
    return SectionDiplomaCore.fromJson(response.data!);
  }
}
