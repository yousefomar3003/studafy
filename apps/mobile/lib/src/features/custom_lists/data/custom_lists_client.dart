import 'package:dio/dio.dart';

import '../domain/custom_list.dart';

/// Hand-written client for custom lists (OpenAPI tag "Custom lists"), for the reason given on
/// `domain/custom_list.dart`. Reads only: every write is a web session's. A list outside the
/// signed-in user's audience answers 404, exactly like one that does not exist. Wired on
/// [authenticatedDio] by `customListsClientProvider`.
class CustomListsClient {
  CustomListsClient(this._dio);

  final Dio _dio;

  /// `GET /api/custom-lists` -- the lists the signed-in user may read, archived ones left out.
  Future<List<CustomListSummary>> lists() async {
    final response = await _dio.get<Map<String, Object?>>('/api/custom-lists');
    final lists = response.data?['lists'];
    return [
      if (lists is List)
        for (final list in lists)
          CustomListSummary.fromJson(Map<String, Object?>.from(list as Map)),
    ];
  }

  /// `GET /api/custom-lists/{listId}` -- the list and its columns.
  Future<CustomListDetail> detail(String listId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/custom-lists/$listId',
    );
    return CustomListDetail.fromJson(response.data ?? const {});
  }

  /// `GET /api/custom-lists/{listId}/rows` -- one page, searched by [q] and sorted by [sort]
  /// (`created_at`, `updated_at`, `link` or a non-sensitive column id).
  Future<CustomListRowPage> rows(
    String listId, {
    String? q,
    String? sort,
    bool descending = false,
    int limit = 50,
    int offset = 0,
  }) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/custom-lists/$listId/rows',
      queryParameters: {
        if (q != null && q.trim().isNotEmpty) 'q': q.trim(),
        'sort': ?sort,
        if (sort != null) 'order': descending ? 'desc' : 'asc',
        'limit': limit,
        'offset': offset,
      },
    );
    return CustomListRowPage.fromJson(response.data ?? const {});
  }

  /// `GET /api/custom-lists/linked/{subjectKind}/{subjectId}` -- rows of every list the user may
  /// read that link to this student, parent, member of staff or class.
  Future<List<LinkedCustomList>> linked(
    String subjectKind,
    String subjectId,
  ) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/custom-lists/linked/$subjectKind/$subjectId',
    );
    final lists = response.data?['lists'];
    return [
      if (lists is List)
        for (final list in lists)
          LinkedCustomList.fromJson(Map<String, Object?>.from(list as Map)),
    ];
  }
}
