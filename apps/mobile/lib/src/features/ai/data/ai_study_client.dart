import 'package:dio/dio.dart';

import '../domain/ai_study.dart';

/// Client for the per-material AI study surfaces — the length-preset summary, the key-concepts
/// list, and the shared quota snapshot.
///
/// Not generated, same reason as [AskAiClient]: the `AI` tag isn't in the mobile OpenAPI snapshot
/// (`apps/api/openapi.json` has zero `/api/ai/` paths). Unlike the Ask AI stream these are plain
/// buffered `application/json`, so a normal typed `Dio` call is enough — the shared
/// `ErrorMappingInterceptor` turns a non-2xx problem+json body into an [ApiException] on the
/// thrown [DioException]; callers classify it with [AiStudyError.classify].
///
/// Concrete rather than an interface so it matches the other hand-written clients; its one field
/// is private, so tests substitute it by `implements AiStudyClient` over the three methods,
/// overridden through `aiStudyClientProvider`.
class AiStudyClient {
  AiStudyClient(this._dio);

  final Dio _dio;

  /// Summarizes [materialId] at the [length] preset. The server caches each preset independently,
  /// so a repeat request for a preset already generated returns `cached: true` with zero token
  /// cost.
  Future<AiSummary> summarize({
    required String studentId,
    required String materialId,
    required AiSummaryLength length,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/ai/students/$studentId/summarize',
      data: {'materialId': materialId, 'length': length.wire},
    );
    final body = response.data ?? const {};
    return AiSummary(
      text: body['summary'] as String? ?? '',
      length: AiSummaryLength.fromWire(body['length'] as String? ?? length.wire),
      cached: body['cached'] as bool? ?? false,
      sources: _anchors(body['sources']),
    );
  }

  /// Extracts [materialId]'s deduplicated key concepts, each with the anchors it is grounded on.
  Future<List<AiConcept>> concepts({
    required String studentId,
    required String materialId,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/ai/students/$studentId/concepts',
      data: {'materialId': materialId},
    );
    final raw = response.data?['concepts'];
    if (raw is! List) return const [];
    return [
      for (final item in raw)
        if (item is Map<String, dynamic>)
          AiConcept(
            name: item['name'] as String? ?? '',
            explanation: item['explanation'] as String? ?? '',
            sources: _anchors(item['sources']),
          ),
    ];
  }

  /// The caller's AI quota for the current billing period.
  Future<AiUsage> usage() async {
    final response = await _dio.get<Map<String, dynamic>>('/api/ai/usage');
    final body = response.data ?? const {};
    return AiUsage(
      active: body['active'] as bool? ?? false,
      budget: (body['budget'] as num?)?.toInt() ?? 0,
      usedTokens: (body['usedTokens'] as num?)?.toInt() ?? 0,
      heldTokens: (body['heldTokens'] as num?)?.toInt() ?? 0,
      remaining: (body['remaining'] as num?)?.toInt() ?? 0,
    );
  }

  /// Parses a `sources` array (snake_case wire keys) into [AiSourceAnchor]s. Shared by the summary
  /// and concept parsers.
  List<AiSourceAnchor> _anchors(Object? raw) {
    if (raw is! List) return const [];
    return [
      for (final item in raw)
        if (item is Map<String, dynamic>)
          AiSourceAnchor(
            chunkId: item['chunk_id'] as String? ?? '',
            chunkIndex: (item['chunk_index'] as num?)?.toInt() ?? 0,
            order: (item['order'] as num?)?.toInt() ?? 0,
            pageNumber: (item['page_number'] as num?)?.toInt(),
            sectionTitle: item['section_title'] as String?,
          ),
    ];
  }
}
