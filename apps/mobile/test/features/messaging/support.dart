import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/features/messaging/data/messaging_client.dart';
import 'package:studafy_mobile/src/features/messaging/domain/messaging.dart';

const parentUserId = 'parent-user';
const teacherUserId = 'teacher-user';

/// A fixed "now" for clocks and relative times: 2026-03-10 12:00 local.
final fixedNow = DateTime(2026, 3, 10, 12);

Map<String, Object?> conversationJson({
  String id = 'conv-1',
  String studentId = 'child-1',
  String studentName = 'Amir',
  String teacherName = 'Rana Haddad',
  String parentName = 'Bassel Fares',
  String? lastBody = 'See you tomorrow',
  String lastSenderId = teacherUserId,
  DateTime? lastAt,
  int unread = 0,
  int attachmentCount = 0,
  bool blockedByMe = false,
  bool hasBlockedMe = false,
}) {
  final at = (lastAt ?? fixedNow.subtract(const Duration(minutes: 5)))
      .toUtc()
      .toIso8601String();
  return {
    'id': id,
    'student': {'id': studentId, 'name': studentName},
    'parent': {'id': parentUserId, 'name': parentName},
    'teacher': {'id': teacherUserId, 'name': teacherName},
    'last_message': lastBody == null
        ? null
        : {
            'body': lastBody,
            'attachment_count': attachmentCount,
            'sender_id': lastSenderId,
            'created_at': at,
          },
    'unread_count': unread,
    'updated_at': at,
    'blocked_by_me': blockedByMe,
    'has_blocked_me': hasBlockedMe,
  };
}

Conversation conversationFixture({
  String id = 'conv-1',
  String studentId = 'child-1',
  String studentName = 'Amir',
  String teacherName = 'Rana Haddad',
  String? lastBody = 'See you tomorrow',
  String lastSenderId = teacherUserId,
  DateTime? lastAt,
  int unread = 0,
  int attachmentCount = 0,
  bool blockedByMe = false,
  bool hasBlockedMe = false,
}) => Conversation.fromJson(
  conversationJson(
    id: id,
    studentId: studentId,
    studentName: studentName,
    teacherName: teacherName,
    lastBody: lastBody,
    lastSenderId: lastSenderId,
    lastAt: lastAt,
    unread: unread,
    attachmentCount: attachmentCount,
    blockedByMe: blockedByMe,
    hasBlockedMe: hasBlockedMe,
  ),
);

/// An attachment as the API serves it, with a URL valid for five minutes from [fixedNow].
MessageAttachment attachmentFixture(String id, {String? url}) =>
    MessageAttachment(
      id: id,
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      downloadUrl: url ?? 'https://storage.test/$id.jpg',
      downloadUrlExpiresAt: fixedNow.add(const Duration(minutes: 5)),
    );

/// A [DioException] carrying the problem the API would send.
DioException apiError(int status, String code) {
  final options = RequestOptions(path: '/api/messaging');
  return DioException(
    requestOptions: options,
    response: Response(requestOptions: options, statusCode: status),
    error: ApiException(status: status, title: code, code: code),
  );
}

ChatMessage messageFixture(
  String id, {
  String conversationId = 'conv-1',
  String senderId = teacherUserId,
  String? body,
  required DateTime at,
  List<MessageAttachment> attachments = const [],
}) => ChatMessage(
  id: id,
  conversationId: conversationId,
  senderId: senderId,
  body: body ?? 'Message $id',
  createdAt: at,
  attachments: attachments,
);

typedef ReportCall = ({
  String conversationId,
  ReportReason reason,
  String? messageId,
  String? details,
  bool alsoBlock,
});

typedef ListMessagesCall = ({int? limit, String? before, DateTime? since});

/// An in-memory messaging server: one message list per conversation, `since` answered
/// inclusively (so callers must de-duplicate), `before` paging by id.
class FakeMessagingClient extends Fake implements MessagingClient {
  FakeMessagingClient({
    List<Conversation>? conversations,
    Map<String, List<MessagingContact>>? contacts,
    List<TeacherMessagingStudent>? teacherContacts,
    Map<String, List<ChatMessage>>? messages,
  }) : conversations = conversations ?? [],
       contacts = contacts ?? {},
       teacherContacts = teacherContacts ?? [],
       messages = messages ?? {};

  List<Conversation> conversations;
  Map<String, List<MessagingContact>> contacts;
  List<TeacherMessagingStudent> teacherContacts;
  Map<String, List<ChatMessage>> messages;

  final listConversationCalls = <String?>[];
  final listMessageCalls = <ListMessagesCall>[];
  final readCalls = <String>[];
  final sentBodies = <String>[];
  final sentStorageKeys = <List<String>>[];
  final uploadRequests =
      <({String fileName, String contentType, int sizeBytes})>[];
  final uploadedUrls = <String>[];
  final blockCalls = <String>[];
  final unblockCalls = <String>[];
  final reportCalls = <ReportCall>[];
  final profileCalls = <String>[];

  /// Answers to [fetchProfile], by conversation id.
  Map<String, ParticipantProfile> profiles = {};

  /// When set, [fetchProfile] throws it.
  Object? profileError;

  /// When set, [requestAttachmentUpload] throws it.
  Object? uploadRequestError;

  /// When set, [uploadAttachment] waits on it (after reporting half progress).
  Completer<void>? uploadGate;

  /// When set, [report] throws it.
  Object? reportError;

  /// When set, [block] / [unblock] throw it.
  Object? blockError;

  /// The flags [block] answers with.
  BlockState blockAnswer = const BlockState(
    blockedByMe: true,
    hasBlockedMe: false,
  );

  int _uploadSeq = 0;
  final started = <({String studentId, String teacherId})>[];
  final startedByTeacher = <({String studentId, String parentId})>[];

  /// When set, [startTeacherConversation] throws it.
  Object? startError;

  /// When set, [sendMessage] waits on it before storing (to observe the optimistic state).
  Completer<void>? sendGate;

  /// When set, [sendMessage] throws it (after the gate).
  Object? sendError;

  /// When set, [listMessages] throws it.
  Object? listError;

  int _serverSeq = 0;
  DateTime sendClock = fixedNow;

  @override
  Future<List<Conversation>> listConversations({String? studentId}) async {
    listConversationCalls.add(studentId);
    return [
      for (final conversation in conversations)
        if (studentId == null || conversation.student.id == studentId)
          conversation,
    ];
  }

  @override
  Future<List<MessagingContact>> fetchContacts(String studentId) async =>
      contacts[studentId] ?? const [];

  @override
  Future<Conversation> getConversation(String conversationId) async =>
      conversations.firstWhere(
        (conversation) => conversation.id == conversationId,
      );

  @override
  Future<Conversation> startConversation({
    required String studentId,
    required String teacherId,
  }) async {
    started.add((studentId: studentId, teacherId: teacherId));
    final conversation = conversationFixture(
      id: 'conv-new',
      studentId: studentId,
      lastBody: null,
    );
    conversations.add(conversation);
    return conversation;
  }

  @override
  Future<List<TeacherMessagingStudent>> fetchTeacherContacts() async =>
      teacherContacts;

  @override
  Future<Conversation> startTeacherConversation({
    required String studentId,
    required String parentId,
  }) async {
    startedByTeacher.add((studentId: studentId, parentId: parentId));
    if (startError case final error?) throw error;
    final conversation = conversationFixture(
      id: 'conv-new',
      studentId: studentId,
      lastBody: null,
    );
    conversations.add(conversation);
    return conversation;
  }

  @override
  Future<ChatMessagePage> listMessages(
    String conversationId, {
    int? limit,
    String? before,
    DateTime? since,
  }) async {
    listMessageCalls.add((limit: limit, before: before, since: since));
    if (listError case final error?) throw error;
    var all = messages[conversationId] ?? const <ChatMessage>[];
    if (since != null) {
      return ChatMessagePage(
        messages: [
          for (final message in all)
            if (!message.createdAt.isBefore(since)) message,
        ],
        hasMore: false,
      );
    }
    if (before != null) {
      all = all.sublist(0, all.indexWhere((message) => message.id == before));
    }
    final take = limit ?? all.length;
    final start = all.length > take ? all.length - take : 0;
    return ChatMessagePage(messages: all.sublist(start), hasMore: start > 0);
  }

  @override
  Future<ChatMessage> sendMessage(
    String conversationId,
    String body, {
    List<String> storageKeys = const [],
  }) async {
    sentBodies.add(body);
    sentStorageKeys.add(storageKeys);
    if (sendGate case final gate?) await gate.future;
    if (sendError case final error?) throw error;
    final message = ChatMessage(
      id: 'srv-${_serverSeq++}',
      conversationId: conversationId,
      senderId: parentUserId,
      body: body,
      createdAt: sendClock,
      attachments: [
        for (final key in storageKeys) attachmentFixture('att-$key'),
      ],
    );
    final stored = messages[conversationId] ??= [];
    if (!stored.any((existing) => existing.id == message.id)) {
      stored.add(message);
    }
    return message;
  }

  @override
  Future<void> markRead(String conversationId) async {
    readCalls.add(conversationId);
  }

  @override
  Future<AttachmentUploadTicket> requestAttachmentUpload({
    required String fileName,
    required String contentType,
    required int sizeBytes,
  }) async {
    uploadRequests.add((
      fileName: fileName,
      contentType: contentType,
      sizeBytes: sizeBytes,
    ));
    if (uploadRequestError case final error?) throw error;
    final seq = _uploadSeq++;
    return AttachmentUploadTicket(
      uploadUrl: 'https://storage.test/upload/$seq',
      storageKey: 'key-$seq',
      expiresAt: fixedNow.add(const Duration(minutes: 15)),
    );
  }

  @override
  Future<void> uploadAttachment({
    required String uploadUrl,
    required File file,
    required String contentType,
    CancelToken? cancelToken,
    void Function(double progress)? onProgress,
  }) async {
    onProgress?.call(0.5);
    if (uploadGate case final gate?) await gate.future;
    uploadedUrls.add(uploadUrl);
    onProgress?.call(1);
  }

  @override
  Future<ParticipantProfile> fetchProfile(String conversationId) async {
    profileCalls.add(conversationId);
    if (profileError case final error?) throw error;
    return profiles[conversationId]!;
  }

  @override
  Future<BlockState> block(String conversationId) async {
    blockCalls.add(conversationId);
    if (blockError case final error?) throw error;
    return blockAnswer;
  }

  @override
  Future<void> unblock(String conversationId) async {
    unblockCalls.add(conversationId);
    if (blockError case final error?) throw error;
  }

  @override
  Future<ReportResult> report(
    String conversationId, {
    required ReportReason reason,
    String? messageId,
    String? details,
    bool alsoBlock = false,
  }) async {
    reportCalls.add((
      conversationId: conversationId,
      reason: reason,
      messageId: messageId,
      details: details,
      alsoBlock: alsoBlock,
    ));
    if (reportError case final error?) throw error;
    return ReportResult(
      reportId: 'report-${reportCalls.length}',
      block: BlockState(blockedByMe: alsoBlock, hasBlockedMe: false),
    );
  }
}
