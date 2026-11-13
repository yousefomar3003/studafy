import 'package:dio/dio.dart';

import '../domain/ask_ai_conversation.dart';
import '../domain/ask_ai_history.dart';

/// Client for Ask AI chat history: the student's earlier conversations and one conversation's
/// turns (`apps/api/src/modules/ai/routes/ask-history-routes.ts`).
///
/// Hand-written for the same reason as [AskAiClient] — the `AI` tag is excluded from codegen — and
/// kept apart from it so the streaming client's test fakes stay a one-method interface. Plain
/// buffered JSON, so the shared `ErrorMappingInterceptor` turns a problem+json body into an
/// `ApiException` on the thrown [DioException].
class AskAiHistoryClient {
  AskAiHistoryClient(this._dio);

  final Dio _dio;

  /// One page of the student's conversations, most recently active first. Pass the previous
  /// page's [AskAiConversationPage.nextBefore] as [before] for the next one.
  Future<AskAiConversationPage> list({
    required String studentId,
    String? before,
  }) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/api/ai/students/$studentId/conversations',
      queryParameters: {'before': ?before},
    );
    final body = response.data ?? const {};
    final raw = body['conversations'];
    return AskAiConversationPage(
      conversations: [
        if (raw is List)
          for (final item in raw)
            if (item is Map<String, dynamic>)
              AskAiConversationSummary(
                id: item['id']! as String,
                title: item['title'] as String? ?? '',
                messageCount: (item['message_count'] as num?)?.toInt() ?? 0,
                lastMessageAt: DateTime.parse(
                  item['last_message_at']! as String,
                ).toLocal(),
              ),
      ],
      nextBefore: body['next_before'] as String?,
    );
  }

  /// One conversation's persisted turns, ready to reopen. Throws an `ApiException` with code
  /// `AI_CONVERSATION_NOT_FOUND` once the conversation is gone (or never was this student's).
  Future<AskAiStoredConversation> get({
    required String studentId,
    required String conversationId,
  }) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/api/ai/students/$studentId/conversations/$conversationId',
    );
    final body = response.data ?? const {};
    final raw = body['messages'];
    return AskAiStoredConversation(
      id: body['id'] as String? ?? conversationId,
      turns: [
        if (raw is List)
          for (final item in raw)
            if (item is Map<String, dynamic>)
              AskAiTurn(
                question: item['question'] as String? ?? '',
                answer: AskAiAnswerComplete(
                  messageId: item['id']! as String,
                  text: item['answer'] as String? ?? '',
                  citations: _citations(item['citations']),
                ),
              ),
      ],
    );
  }

  List<AskAiCitation> _citations(Object? raw) {
    if (raw is! List) return const [];
    return [
      for (final item in raw)
        if (item is Map<String, dynamic>)
          AskAiCitation(
            order: (item['order'] as num).toInt(),
            chunkId: item['chunk_id']! as String,
            materialId: item['material_id']! as String,
            materialTitle: item['material_title'] as String?,
            pageNumber: (item['page_number'] as num?)?.toInt(),
            sectionTitle: item['section_title'] as String?,
          ),
    ];
  }
}
