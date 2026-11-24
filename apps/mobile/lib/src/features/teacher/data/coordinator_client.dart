import 'package:dio/dio.dart';

import '../domain/coordinator.dart';

/// The subject coordinator's overview (000261). On its own [Dio] like `MarkSheetClient`; a
/// coordinator opens a section's marks with `MarkSheetClient.fetchMarkSheet`, which the API answers
/// read-only (`access: coordinator`). Failures surface as the shared `ApiException`.
class CoordinatorClient {
  CoordinatorClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/my-coordinated-subjects` — for [academicYearId], or the latest active or
  /// finalized year. Empty for a teacher who coordinates nothing.
  Future<CoordinatedSubjects> fetchMySubjects({String? academicYearId}) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/my-coordinated-subjects',
      queryParameters: {'academic_year_id': ?academicYearId},
    );
    return CoordinatedSubjects.fromJson(response.data ?? const {});
  }
}
