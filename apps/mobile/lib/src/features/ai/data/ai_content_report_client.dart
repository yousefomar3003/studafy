import 'package:dio/dio.dart';

import '../../../core/api/api_exception.dart';
import '../domain/ai_content_report.dart';

/// Client for `POST /api/ai/students/{studentId}/reports` (ST-306): the Report action behind every
/// AI output — Ask AI answers, quizzes, flashcard decks, and summaries. The server snapshots the
/// reported content itself, so only the item's identity is sent.
///
/// Hand-written for the same reason as the other `/api/ai/` clients: the `AI` tag is excluded from
/// the mobile OpenAPI codegen (see `pubspec.yaml`'s `swagger_parser.exclude_tags`). The injected
/// [Dio] carries the shared `ErrorMappingInterceptor`, so a non-2xx body surfaces as an
/// `ApiException` on the thrown [DioException].
class AiContentReportClient {
  AiContentReportClient(this._dio);

  final Dio _dio;

  Future<AiReportOutcome> report({
    required String studentId,
    required AiReportTarget target,
    required AiReportReason reason,
    String? details,
  }) async {
    final trimmed = details?.trim();
    try {
      await _dio.post<Map<String, Object?>>(
        '/api/ai/students/$studentId/reports',
        data: {
          'content_type': target.contentType.wire,
          'content_id': target.contentId,
          if (target.summaryLength != null) 'summary_length': target.summaryLength!.wire,
          'reason_category': reason.wire,
          if (trimmed != null && trimmed.isNotEmpty) 'reason': trimmed,
        },
      );
      return AiReportOutcome.filed;
    } on DioException catch (error) {
      if (error.apiError?.status == 409) return AiReportOutcome.alreadyFiled;
      return AiReportOutcome.failed;
    }
  }
}
