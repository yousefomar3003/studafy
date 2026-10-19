import 'dart:io';

import 'package:dio/dio.dart';

import '../domain/messaging.dart';

/// Hand-written client for parent ↔ teacher messaging, `/api/messaging/*`.
///
/// Not generated: the messaging surface postdates the checked-in OpenAPI client, and it is small
/// enough not to warrant a regeneration. Same wiring as `FamilyFinanceClient` — its own [Dio] with
/// the base URL, bearer injection and error mapping `createApiClient` uses, built in
/// `messagingClientProvider`. Throws the shared `ApiException` (attached by
/// `ErrorMappingInterceptor`) on any non-2xx.
class MessagingClient {
  MessagingClient(this._dio, {Dio? uploadDio}) : _uploadDio = uploadDio ?? Dio();

  final Dio _dio;

  /// Bare [Dio] for the pre-signed PUT to object storage — no API base URL, bearer token or
  /// problem+json mapping, none of which apply there (same as `SubmissionFormController`).
  final Dio _uploadDio;

  static const _base = '/api/messaging';

  /// `GET /contacts?student_id=` — the teachers a parent can message about [studentId].
  Future<List<MessagingContact>> fetchContacts(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '$_base/contacts',
      queryParameters: {'student_id': studentId},
    );
    return [
      for (final entry in (response.data!['contacts'] as List<Object?>?) ?? const [])
        MessagingContact.fromJson(Map<String, Object?>.from(entry! as Map)),
    ];
  }

  /// `GET /teacher-contacts` — the students a teacher teaches, each with the parents the
  /// teacher can message about them.
  Future<List<TeacherMessagingStudent>> fetchTeacherContacts() async {
    final response = await _dio.get<Map<String, Object?>>('$_base/teacher-contacts');
    return [
      for (final entry in (response.data!['students'] as List<Object?>?) ?? const [])
        TeacherMessagingStudent.fromJson(Map<String, Object?>.from(entry! as Map)),
    ];
  }

  /// `GET /conversations[?student_id=]` — the caller's conversations, optionally narrowed to one
  /// child (parent).
  Future<List<Conversation>> listConversations({String? studentId}) async {
    final response = await _dio.get<Map<String, Object?>>(
      '$_base/conversations',
      queryParameters: {'student_id': ?studentId},
    );
    return [
      for (final entry in (response.data!['conversations'] as List<Object?>?) ?? const [])
        Conversation.fromJson(Map<String, Object?>.from(entry! as Map)),
    ];
  }

  /// `POST /conversations` — get-or-create the parent's conversation with [teacherId] about
  /// [studentId].
  Future<Conversation> startConversation({
    required String studentId,
    required String teacherId,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '$_base/conversations',
      data: {'student_id': studentId, 'teacher_id': teacherId},
    );
    return _conversationOf(response.data!);
  }

  /// `POST /teacher-conversations` — get-or-create the teacher's conversation with [parentId]
  /// about [studentId] (the same thread the parent would open with this teacher).
  Future<Conversation> startTeacherConversation({
    required String studentId,
    required String parentId,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '$_base/teacher-conversations',
      data: {'student_id': studentId, 'parent_id': parentId},
    );
    return _conversationOf(response.data!);
  }

  /// `GET /conversations/{id}`.
  Future<Conversation> getConversation(String conversationId) async {
    final response = await _dio.get<Map<String, Object?>>('$_base/conversations/$conversationId');
    return _conversationOf(response.data!);
  }

  /// `GET /conversations/{id}/messages` — ascending. [before] (a message id) pages backwards;
  /// [since] returns only messages newer than that instant (polling). Never both: the API
  /// rejects the combination with 400.
  Future<ChatMessagePage> listMessages(
    String conversationId, {
    int? limit,
    String? before,
    DateTime? since,
  }) async {
    assert(before == null || since == null, 'before and since are mutually exclusive');
    final response = await _dio.get<Map<String, Object?>>(
      '$_base/conversations/$conversationId/messages',
      queryParameters: {
        'limit': ?limit,
        'before': ?before,
        'since': ?since?.toUtc().toIso8601String(),
      },
    );
    final body = response.data!;
    return ChatMessagePage(
      messages: [
        for (final entry in (body['messages'] as List<Object?>?) ?? const [])
          ChatMessage.fromJson(Map<String, Object?>.from(entry! as Map)),
      ],
      hasMore: (body['has_more'] as bool?) ?? false,
    );
  }

  /// `POST /conversations/{id}/messages` — returns the stored message. [body] may be empty when
  /// [storageKeys] (staged by [requestAttachmentUpload] + [uploadAttachment]) carries 1–4 images.
  Future<ChatMessage> sendMessage(
    String conversationId,
    String body, {
    List<String> storageKeys = const [],
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '$_base/conversations/$conversationId/messages',
      data: {
        'body': body,
        if (storageKeys.isNotEmpty)
          'attachments': [
            for (final key in storageKeys) {'storage_key': key},
          ],
      },
    );
    return ChatMessage.fromJson(Map<String, Object?>.from(response.data!['message']! as Map));
  }

  /// `POST /api/storage/uploads/request-upload` for the `message.attachment` content class — a
  /// pre-signed PUT slot for one image. Not confirmed afterwards: the send does that.
  Future<AttachmentUploadTicket> requestAttachmentUpload({
    required String fileName,
    required String contentType,
    required int sizeBytes,
  }) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/storage/uploads/request-upload',
      data: {
        'content_class': 'message.attachment',
        'file_name': fileName,
        'content_type': contentType,
        'size_bytes': sizeBytes,
      },
    );
    return AttachmentUploadTicket.fromJson(response.data!);
  }

  /// PUTs [file]'s bytes to a pre-signed [uploadUrl] with the declared [contentType], reporting
  /// progress as a 0–1 fraction.
  Future<void> uploadAttachment({
    required String uploadUrl,
    required File file,
    required String contentType,
    CancelToken? cancelToken,
    void Function(double progress)? onProgress,
  }) async {
    final length = await file.length();
    await _uploadDio.put<void>(
      uploadUrl,
      data: file.openRead(),
      cancelToken: cancelToken,
      options: Options(contentType: contentType, headers: {Headers.contentLengthHeader: length}),
      onSendProgress: (sent, total) => onProgress?.call(total > 0 ? sent / total : 0),
    );
  }

  /// `GET /conversations/{id}/profile` — the other participant's profile.
  Future<ParticipantProfile> fetchProfile(String conversationId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '$_base/conversations/$conversationId/profile',
    );
    return ParticipantProfile.fromJson(
      Map<String, Object?>.from(response.data!['profile']! as Map),
    );
  }

  /// `POST /conversations/{id}/block` — blocks the other participant (idempotent).
  Future<BlockState> block(String conversationId) async {
    final response = await _dio.post<Map<String, Object?>>(
      '$_base/conversations/$conversationId/block',
    );
    return BlockState.fromJson(response.data!);
  }

  /// `DELETE /conversations/{id}/block` — removes the caller's own block, if any.
  Future<void> unblock(String conversationId) async {
    await _dio.delete<void>('$_base/conversations/$conversationId/block');
  }

  /// `POST /conversations/{id}/reports` — reports the conversation, or one message in it when
  /// [messageId] is set, optionally blocking the other participant at the same time. 409
  /// `MESSAGE_REPORT_ALREADY_OPEN` when the caller already has an open report on it.
  Future<ReportResult> report(
    String conversationId, {
    required ReportReason reason,
    String? messageId,
    String? details,
    bool alsoBlock = false,
  }) async {
    final trimmed = details?.trim();
    final response = await _dio.post<Map<String, Object?>>(
      '$_base/conversations/$conversationId/reports',
      data: {
        'reason_category': reason.wire,
        'message_id': ?messageId,
        if (trimmed != null && trimmed.isNotEmpty) 'details': trimmed,
        if (alsoBlock) 'also_block': true,
      },
    );
    return ReportResult.fromJson(response.data!);
  }

  /// `POST /conversations/{id}/read` — marks everything in the conversation read for the caller.
  Future<void> markRead(String conversationId) async {
    await _dio.post<void>('$_base/conversations/$conversationId/read');
  }

  Conversation _conversationOf(Map<String, Object?> body) =>
      Conversation.fromJson(Map<String, Object?>.from(body['conversation']! as Map));
}
