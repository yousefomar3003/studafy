import 'dart:convert';

import '../domain/ask_ai_conversation.dart';

/// The wire events of the Ask AI SSE stream, one Dart type per `event:` frame the endpoint
/// emits (`apps/api/src/modules/ai/routes/ask-routes.ts`). These are the raw contract; the
/// controller folds a sequence of them into the [AskAiConversation] the screen renders.
///
/// The answer path is `sources` → one `delta` per token chunk → `done`. Any of `refusal`,
/// `moderationBlocked`, or `error` replaces the tail of that sequence as a terminal event —
/// the stream has already started, so the server can't fall back to an HTTP status.
sealed class AskAiEvent {
  const AskAiEvent();
}

/// First frame of the answer path: the numbered sources the model was grounded on and the
/// conversation id to thread follow-ups onto.
class AskAiSourcesEvent extends AskAiEvent {
  const AskAiSourcesEvent({required this.conversationId, required this.sources});

  final String conversationId;
  final List<AskAiCitation> sources;
}

/// One token chunk. [delta] is the incremental text to append, not the running total.
class AskAiDeltaEvent extends AskAiEvent {
  const AskAiDeltaEvent(this.delta);
  final String delta;
}

/// Terminal success frame: the authoritative full answer, the validated citations, and the
/// persisted message id.
class AskAiDoneEvent extends AskAiEvent {
  const AskAiDoneEvent({
    required this.messageId,
    required this.text,
    required this.citations,
  });

  final String messageId;
  final String text;
  final List<AskAiCitation> citations;
}

/// Terminal refusal frame: retrieval fell below the grounding bar. Carries the nearest topics.
class AskAiRefusalEvent extends AskAiEvent {
  const AskAiRefusalEvent(this.topics);
  final List<AskAiNearestTopic> topics;
}

/// Terminal frame: output moderation blocked the generated answer.
class AskAiModerationBlockedEvent extends AskAiEvent {
  const AskAiModerationBlockedEvent(this.guidance);
  final String guidance;
}

/// Terminal frame: a provider/network failure mid-stream. [code] is `AI_LLM_UNAVAILABLE` or
/// `AI_LLM_REQUEST_REJECTED`.
class AskAiStreamErrorEvent extends AskAiEvent {
  const AskAiStreamErrorEvent({required this.code, required this.message});
  final String code;
  final String message;
}

/// Decodes one `{event, data}` SSE frame into an [AskAiEvent], or null for a frame that isn't
/// part of the documented contract (a heartbeat comment, an unknown event name) — the caller
/// skips those rather than failing the stream.
AskAiEvent? decodeAskAiEvent(String event, String data) {
  final Object? json = data.isEmpty ? null : jsonDecode(data);
  if (json is! Map<String, Object?>) return null;

  switch (event) {
    case 'sources':
      return AskAiSourcesEvent(
        conversationId: json['conversation_id']! as String,
        sources: _citationList(json['sources']),
      );
    case 'delta':
      return AskAiDeltaEvent(json['delta'] as String? ?? '');
    case 'done':
      return AskAiDoneEvent(
        messageId: json['message_id']! as String,
        text: json['text'] as String? ?? '',
        citations: _citationList(json['citations']),
      );
    case 'refusal':
      return AskAiRefusalEvent(_topicList(json['topics']));
    case 'moderation_blocked':
      return AskAiModerationBlockedEvent(json['guidance'] as String? ?? '');
    case 'error':
      return AskAiStreamErrorEvent(
        code: json['code'] as String? ?? 'AI_LLM_UNAVAILABLE',
        message: json['message'] as String? ?? '',
      );
    default:
      return null;
  }
}

List<AskAiCitation> _citationList(Object? raw) {
  if (raw is! List) return const [];
  return [
    for (final item in raw)
      if (item is Map<String, Object?>)
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

List<AskAiNearestTopic> _topicList(Object? raw) {
  if (raw is! List) return const [];
  return [
    for (final item in raw)
      if (item is Map<String, Object?>)
        AskAiNearestTopic(
          chunkId: item['chunk_id']! as String,
          materialTitle: item['material_title'] as String?,
          sectionTitle: item['section_title'] as String?,
        ),
  ];
}

/// A single decoded SSE frame: its `event:` name and the accumulated `data:` payload.
class SseFrame {
  const SseFrame(this.event, this.data);
  final String event;
  final String data;
}

/// Parses a raw byte stream of `text/event-stream` into [SseFrame]s.
///
/// Minimal on purpose — it implements only what the Ask AI endpoint uses: `event:` and `data:`
/// fields, `\n\n` frame boundaries, `:`-prefixed comment lines ignored. A frame is emitted on
/// the blank line that terminates it; multiple `data:` lines in one frame are joined with `\n`
/// per the SSE spec (the endpoint sends single-line JSON, but this stays correct if that
/// changes). Bytes are decoded as UTF-8 across chunk boundaries.
Stream<SseFrame> parseSseFrames(Stream<List<int>> byteStream) async* {
  final pending = StringBuffer();
  String? event;
  final data = StringBuffer();
  var sawField = false;

  SseFrame? flush() {
    if (!sawField) return null;
    final frame = SseFrame(event ?? 'message', data.toString());
    event = null;
    data.clear();
    sawField = false;
    return frame;
  }

  await for (final chunk in byteStream.transform(utf8.decoder)) {
    pending.write(chunk);
    var rest = pending.toString();
    var newline = rest.indexOf('\n');
    while (newline != -1) {
      final line = rest.substring(0, newline).replaceAll('\r', '');
      rest = rest.substring(newline + 1);

      if (line.isEmpty) {
        final frame = flush();
        if (frame != null) yield frame;
      } else if (line.startsWith(':')) {
        // Comment / heartbeat — ignore.
      } else if (line.startsWith('event:')) {
        event = line.substring(6).trim();
        sawField = true;
      } else if (line.startsWith('data:')) {
        if (data.isNotEmpty) data.write('\n');
        data.write(_stripFieldValue(line.substring(5)));
        sawField = true;
      }

      newline = rest.indexOf('\n');
    }
    pending
      ..clear()
      ..write(rest);
  }

  final frame = flush();
  if (frame != null) yield frame;
}

/// An SSE field value has exactly one optional leading space stripped (`data: x` → `x`,
/// `data:  x` → ` x`).
String _stripFieldValue(String raw) => raw.startsWith(' ') ? raw.substring(1) : raw;
