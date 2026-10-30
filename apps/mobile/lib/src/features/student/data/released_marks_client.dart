import 'package:dio/dio.dart';

import '../domain/released_marks.dart';

/// Hand-written client for a student's approved marks (OpenAPI tag `Results`), shared by the
/// student's own screen and a parent viewing a linked child. The API scopes the call: school
/// leadership, the student themself, or a linked parent; and only marks from approved mark
/// sheets are ever returned.
class ReleasedMarksClient {
  ReleasedMarksClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/students/{studentId}/marks` — newest year first, its terms in order and
  /// the annual period last.
  Future<List<ReleasedMarkPeriod>> fetchMarks(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/marks',
    );
    return [
      for (final row
          in (response.data?['periods'] as List<Object?>?) ?? const <Object?>[])
        ReleasedMarkPeriod.fromJson(Map<String, Object?>.from(row! as Map)),
    ];
  }
}
