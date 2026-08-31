import 'package:dio/dio.dart';

import '../domain/ai_usage.dart';

/// Client for the AI tab's one read — `GET /api/ai/usage`, the quota snapshot the hub screen
/// renders once the add-on is known active.
///
/// Not generated, same reason as [AskAiClient] and [AiStudyClient]: the `AI` tag is excluded from
/// the mobile OpenAPI codegen (see `pubspec.yaml`'s `swagger_parser.exclude_tags`), so every
/// `/api/ai/` surface the app uses is a hand-written Dio call. This one is a plain buffered
/// `application/json` GET — the shared [ErrorMappingInterceptor] on the injected [Dio] turns a
/// non-2xx problem+json body into an [ApiException] on the thrown [DioException], which
/// `aiHubStatusProvider` classifies with [aiHubStatusFromErrorCode].
///
/// Concrete rather than an interface so it matches the other hand-written clients; its one field
/// is private, so tests substitute it by `implements AiHubClient` over the single method.
class AiHubClient {
  AiHubClient(this._dio);

  final Dio _dio;

  /// The signed-in caller's AI quota for the current billing period. Takes no studentId — the
  /// endpoint resolves the caller's own entitlement from the session's auth context server-side
  /// (`usage-routes.ts`).
  Future<AiUsage> usage() async {
    final response = await _dio.get<Map<String, dynamic>>('/api/ai/usage');
    final body = response.data ?? const {};
    return AiUsage(
      budget: (body['budget'] as num?)?.toInt() ?? 0,
      usedTokens: (body['usedTokens'] as num?)?.toInt() ?? 0,
      heldTokens: (body['heldTokens'] as num?)?.toInt() ?? 0,
      remaining: (body['remaining'] as num?)?.toInt() ?? 0,
      periodEnd: DateTime.tryParse(body['periodEnd'] as String? ?? '') ?? DateTime.now(),
    );
  }
}
