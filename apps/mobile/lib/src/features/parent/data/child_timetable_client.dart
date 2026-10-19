import 'package:dio/dio.dart';

import '../domain/child_timetable.dart';

/// Hand-written client for `GET /api/reports/children/{studentId}/timetable` — a linked child's
/// approved weekly timetable, with display labels resolved server-side.
///
/// Not generated: the endpoint postdates the checked-in OpenAPI client. Same wiring as
/// `FamilyFinanceClient` (`childTimetableClientProvider`). The endpoint is
/// parent-only and scoped to the caller's `parent_child_links`; an unlinked child answers 403,
/// surfaced as the shared `ApiException`.
class ChildTimetableClient {
  ChildTimetableClient(this._dio);

  final Dio _dio;

  Future<ChildTimetable> fetch(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/reports/children/$studentId/timetable',
    );
    return ChildTimetable.fromJson(response.data!);
  }
}
