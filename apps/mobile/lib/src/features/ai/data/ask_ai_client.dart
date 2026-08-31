import 'dart:convert';

import 'package:dio/dio.dart';

import '../../../core/api/api_exception.dart';
import 'ask_ai_events.dart';

/// The outcome of flagging an answer for teacher review.
enum AskAiReportOutcome {
  /// The report was stored (`201`).
  filed,

  /// This student already reported this message (`409 AI_ANSWER_REPORTED`).
  alreadyFiled,

  /// The report couldn't be filed (network, `404`, anything else).
  failed,
}

/// Client for the Ask AI surface — not generated, for the same reason as
/// `StorageDownloadClient`: the streaming answer endpoint is `text/event-stream`, which a
/// Retrofit-style typed client can't model (it only types a single decoded 2xx body), and the
/// AI tag isn't in the mobile OpenAPI snapshot yet regardless. Hand-calls the two paths and
/// hand-parses their responses, whose shapes are stable and documented in `ask-routes.ts` /
/// `report-routes.ts`.
///
/// Concrete rather than an interface so it matches `StorageDownloadClient`; tests substitute it
/// by `implements AskAiClient` (its one field is private, so the interface is just the two
/// methods), overridden through `askAiClientProvider`.
class AskAiClient {
  AskAiClient(this._dio);

  final Dio _dio;

  /// Streams a grounded answer to [question]. Yields the SSE events in order: an
  /// [AskAiSourcesEvent], then an [AskAiDeltaEvent] per token chunk, then one terminal event
  /// ([AskAiDoneEvent] / [AskAiRefusalEvent] / [AskAiModerationBlockedEvent] /
  /// [AskAiStreamErrorEvent]).
  ///
  /// Everything that can fail *before* the stream opens — validation, the kill switch,
  /// entitlement, quota, input moderation — comes back as a normal `application/problem+json`
  /// response and is thrown here as an [ApiException] (read `.code` to branch). Once the stream
  /// is open the endpoint reports failures as a terminal event instead, never an exception.
  ///
  /// [conversationId] threads a follow-up onto an existing conversation. [level] is the
  /// student's age band for moderation strictness (`elementary` | `middle` | `high`).
  Stream<AskAiEvent> ask({
    required String studentId,
    required String question,
    String? conversationId,
    String level = 'high',
  }) async* {
    final payload = <String, Object?>{'question': question, 'level': level};
    if (conversationId != null) payload['conversation_id'] = conversationId;

    final response = await _dio.post<ResponseBody>(
      '/api/ai/students/$studentId/ask',
      data: payload,
      options: Options(
        responseType: ResponseType.stream,
        headers: {'Accept': 'text/event-stream'},
        // Take the response whatever the status: a non-2xx here is a problem+json body we want
        // to read and rethrow with its code intact, not a bare DioException.
        validateStatus: (_) => true,
      ),
    );

    final body = response.data!;
    if (response.statusCode != 200) {
      throw await _problemFromStream(response);
    }

    await for (final frame in parseSseFrames(body.stream)) {
      final event = decodeAskAiEvent(frame.event, frame.data);
      if (event != null) yield event;
    }
  }

  /// Flags [messageId] for teacher review with the student's stated [reason].
  Future<AskAiReportOutcome> report({
    required String studentId,
    required String messageId,
    required String reason,
  }) async {
    try {
      await _dio.post<Map<String, Object?>>(
        '/api/ai/students/$studentId/messages/$messageId/report',
        data: {'reason': reason},
      );
      return AskAiReportOutcome.filed;
    } on DioException catch (error) {
      if (error.apiError?.status == 409) return AskAiReportOutcome.alreadyFiled;
      return AskAiReportOutcome.failed;
    }
  }

  /// Drains a streamed error response and rebuilds the [ApiException] the
  /// [ErrorMappingInterceptor] would have produced for a buffered one — it can't, because
  /// [ResponseType.stream] leaves the body unread.
  Future<ApiException> _problemFromStream(Response<ResponseBody> response) async {
    final bytes = <int>[];
    await for (final chunk in response.data!.stream) {
      bytes.addAll(chunk);
    }

    Map<String, Object?>? problem;
    try {
      final decoded = jsonDecode(utf8.decode(bytes));
      if (decoded is Map) problem = Map<String, Object?>.from(decoded);
    } catch (_) {
      // Not a problem+json body (proxy error page, empty) — fall through to a generic shape.
    }

    return ApiException(
      status: (problem?['status'] as num?)?.toInt() ?? response.statusCode ?? -1,
      title: problem?['title'] as String? ?? response.statusMessage ?? 'Ask AI request failed',
      code: problem?['code'] as String?,
      detail: problem?['detail'] as String?,
      instance: problem?['instance'] as String?,
      type: problem?['type'] as String?,
      requestId:
          problem?['request_id'] as String? ?? response.headers.value('x-request-id'),
      problem: problem,
    );
  }
}
