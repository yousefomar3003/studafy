import 'package:dio/dio.dart';

import '../domain/ai_explain.dart';

/// Client for "Explain it simply": finds passages for a topic in the student's materials
/// (`POST .../search`) and rewrites one in plain language (`POST .../explain`).
///
/// Hand-written for the same reason as `AiStudyClient` — the `AI` tag is excluded from codegen —
/// and plain buffered JSON like it, so the shared `ErrorMappingInterceptor` turns a problem+json
/// body into an `ApiException` on the thrown [DioException]; callers classify it with
/// `AiStudyError.classify`.
class AiExplainClient {
  AiExplainClient(this._dio);

  final Dio _dio;

  /// The passages best matching [topic], most relevant first. Empty when nothing in the student's
  /// materials matches.
  Future<List<AiExplainPassage>> search({
    required String studentId,
    required String topic,
    int limit = 5,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/ai/students/$studentId/search',
      data: {'query': topic, 'limit': limit},
    );
    final raw = response.data?['results'];
    if (raw is! List) return const [];
    return [
      for (final item in raw)
        if (item is Map<String, dynamic>)
          AiExplainPassage(
            chunkId: item['chunk_id']! as String,
            materialId: item['material_id']! as String,
            content: item['content'] as String? ?? '',
            materialTitle: item['material_title'] as String?,
            pageNumber: (item['page_number'] as num?)?.toInt(),
            sectionTitle: item['section_title'] as String?,
          ),
    ];
  }

  /// [chunkId]'s passage explained in plain language at [level].
  Future<String> explain({
    required String studentId,
    required String chunkId,
    required AiExplainLevel level,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/ai/students/$studentId/explain',
      data: {'chunkId': chunkId, 'level': level.wire},
    );
    return response.data?['explanation'] as String? ?? '';
  }
}
