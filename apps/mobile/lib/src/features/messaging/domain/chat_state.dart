import 'messaging.dart';

/// Where an optimistically shown outgoing message is in its round trip.
enum PendingStatus { sending, failed }

/// Why a pending message failed, each with its own hint under the bubble:
/// - [rateLimited] — the server's send limit (HTTP 429), worth telling the user to wait;
/// - [blocked] — 403 `MESSAGING_BLOCKED`, a block in either direction;
/// - [quotaExceeded] — 402 `STORAGE_QUOTA_EXCEEDED`, the school's storage is full;
/// - [storageUnavailable] — 503 `STORAGE_NOT_CONFIGURED`, images can't be sent at all;
/// - [invalid] — 400 (`VALIDATION_FAILED` and the storage key / checksum errors);
/// - [other] — anything else.
enum PendingFailure { rateLimited, blocked, quotaExceeded, storageUnavailable, invalid, other }

/// An image already uploaded for a message: the local file shown while sending and the staged
/// object's [storageKey], which stays sendable (and re-sendable on retry) for about a day.
class PendingImage {
  const PendingImage({required this.localPath, required this.storageKey});

  final String localPath;
  final String storageKey;
}

/// A message the user sent that the server has not confirmed yet — shown immediately, marked
/// failed (with retry) if the send errors.
class PendingMessage {
  const PendingMessage({
    required this.localId,
    required this.body,
    required this.createdAt,
    required this.status,
    this.images = const [],
    this.failure,
  });

  final String localId;
  final String body;
  final DateTime createdAt;
  final PendingStatus status;

  /// Uploaded images going with the message, in display order.
  final List<PendingImage> images;

  /// Set only while [status] is [PendingStatus.failed].
  final PendingFailure? failure;

  PendingMessage copyWith({PendingStatus? status, PendingFailure? failure}) => PendingMessage(
    localId: localId,
    body: body,
    createdAt: createdAt,
    images: images,
    status: status ?? this.status,
    failure: (status ?? this.status) == PendingStatus.failed ? (failure ?? this.failure) : null,
  );
}

/// One open chat: confirmed [messages] (ascending), [pending] outgoing ones after them, and the
/// paging / loading flags around them.
class ChatState {
  const ChatState({
    this.messages = const [],
    this.pending = const [],
    this.hasMore = false,
    this.isLoading = true,
    this.isLoadingOlder = false,
    this.error,
    this.block,
  });

  final List<ChatMessage> messages;
  final List<PendingMessage> pending;

  /// Whether older messages exist before [messages]' first.
  final bool hasMore;

  /// The first page has not arrived yet.
  final bool isLoading;
  final bool isLoadingOlder;

  /// Why the first page failed to load; null once it has loaded. Later poll / page failures
  /// leave what is already shown in place instead.
  final Object? error;

  /// The block flags learned during this chat (a block / unblock, a report that blocked, the
  /// profile, a send refused with `MESSAGING_BLOCKED`). Null until then — the screen falls back
  /// to the flags the conversation was opened with.
  final BlockState? block;

  /// The newest confirmed message's timestamp — the `since` cursor for polling.
  DateTime? get latestCreatedAt => messages.isEmpty ? null : messages.last.createdAt;

  ChatState copyWith({
    List<ChatMessage>? messages,
    List<PendingMessage>? pending,
    bool? hasMore,
    bool? isLoading,
    bool? isLoadingOlder,
    Object? error,
    bool clearError = false,
    BlockState? block,
  }) {
    return ChatState(
      messages: messages ?? this.messages,
      pending: pending ?? this.pending,
      hasMore: hasMore ?? this.hasMore,
      isLoading: isLoading ?? this.isLoading,
      isLoadingOlder: isLoadingOlder ?? this.isLoadingOlder,
      error: clearError ? null : (error ?? this.error),
      block: block ?? this.block,
    );
  }
}
