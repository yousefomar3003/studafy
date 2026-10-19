import 'dart:async';
import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../data/messaging_client.dart';
import '../domain/chat_state.dart';
import '../domain/messaging.dart';

/// [MessagingClient] on its own [Dio], wired exactly like `familyFinanceClientProvider` — same
/// base URL, same bearer injection, same [ErrorMappingInterceptor].
final messagingClientProvider = Provider<MessagingClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return MessagingClient(dio);
});

/// The signed-in user's id (the token's `sub`), which `sender_id` is compared against to tell
/// "mine" from "theirs". Watches [authStatusProvider] for the same reason `parentUserIdProvider`
/// does: the session object itself is not observable.
final messagingUserIdProvider = Provider<String?>((ref) {
  ref.watch(authStatusProvider);
  return ref.watch(authSessionProvider).userId;
});

/// The caller's conversations, newest activity first. Keyed by student id: a parent's Messages
/// tab asks for the selected child's; `null` asks for every conversation (the teacher's list,
/// and the unread badge on either role's Messages tab).
final conversationsProvider = FutureProvider.family<List<Conversation>, String?>((
  ref,
  studentId,
) async {
  final conversations = await ref
      .watch(messagingClientProvider)
      .listConversations(studentId: studentId);
  return conversations.toList()..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
});

/// Sum of `unread_count` over every conversation, for the Messages tab badge. Zero while loading
/// or on error — a badge is never worth an error state.
final unreadMessagesTotalProvider = Provider<int>((ref) {
  final conversations = ref.watch(conversationsProvider(null)).value;
  return conversations == null ? 0 : totalUnread(conversations);
});

/// The teachers a parent can message about one child.
final messagingContactsProvider = FutureProvider.autoDispose.family<List<MessagingContact>, String>(
  (ref, studentId) {
    return ref.watch(messagingClientProvider).fetchContacts(studentId);
  },
);

/// The students a teacher teaches and the parents the teacher can message about each.
final teacherMessagingContactsProvider = FutureProvider.autoDispose<List<TeacherMessagingStudent>>(
  (ref) => ref.watch(messagingClientProvider).fetchTeacherContacts(),
);

/// Re-fetches every conversation list (and with it the unread badge). Called on pull-to-refresh,
/// when the Messages tab is re-selected, and when a chat is closed.
Future<void> refreshConversations(WidgetRef ref, {String? studentId}) async {
  ref.invalidate(conversationsProvider);
  try {
    await ref.read(conversationsProvider(studentId).future);
  } on Object {
    // Surfaced by the list itself; the refresh gesture only needs to finish.
  }
}

/// The other participant of a conversation (name, role, classes / children, block flags), for
/// the chat's profile sheet. Keyed by conversation id.
final participantProfileProvider = FutureProvider.autoDispose.family<ParticipantProfile, String>(
  (ref, conversationId) => ref.watch(messagingClientProvider).fetchProfile(conversationId),
);

/// Maps a send / upload error to the hint shown for it. Everything not recognized is
/// [PendingFailure.other].
PendingFailure pendingFailureOf(Object error) {
  final apiError = error is DioException ? error.apiError : null;
  if (apiError == null) return PendingFailure.other;
  return switch ((apiError.status, apiError.code)) {
    (429, _) => PendingFailure.rateLimited,
    (_, 'MESSAGING_BLOCKED') => PendingFailure.blocked,
    (_, 'STORAGE_QUOTA_EXCEEDED') || (402, _) => PendingFailure.quotaExceeded,
    (_, 'STORAGE_NOT_CONFIGURED') || (503, _) => PendingFailure.storageUnavailable,
    (400, _) => PendingFailure.invalid,
    _ => PendingFailure.other,
  };
}

/// How often an open chat asks for new messages. Override in tests.
final chatPollIntervalProvider = Provider<Duration>((ref) => const Duration(seconds: 5));

/// The clock pending messages are stamped with. Override in tests.
final chatClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// How many messages one page (initial or older) asks for.
const chatPageSize = 30;

/// The largest page the messages endpoint serves (`MAX_MESSAGE_PAGE_SIZE`).
const _maxPageSize = 100;

/// The shortest gap between two [ChatController.refreshAttachments] re-fetches, so a run of
/// image load failures (or an image that is genuinely broken) cannot hammer the API.
const attachmentRefreshCooldown = Duration(seconds: 15);

/// One open chat, keyed by conversation id. Loads the newest page on creation and marks the
/// conversation read; [poll] (driven by [startPolling]) merges anything newer by `since`;
/// [loadOlder] pages backwards by `before`; [send] shows the message immediately and reconciles
/// it with the server's copy.
///
/// Polling is not automatic: the chat screen starts it while it is visible and the app is in
/// the foreground, and stops it on pause / dispose. Auto-disposed with the screen, which also
/// cancels any timer still running.
class ChatController extends Notifier<ChatState> {
  ChatController(this.conversationId);

  final String conversationId;

  Timer? _pollTimer;
  bool _polling = false;
  bool _refreshingAttachments = false;
  DateTime? _lastAttachmentRefresh;
  int _localSeq = 0;

  MessagingClient get _client => ref.read(messagingClientProvider);

  /// Whether the periodic poll is running.
  bool get isPolling => _pollTimer != null;

  @override
  ChatState build() {
    ref.onDispose(stopPolling);
    Future.microtask(load);
    return const ChatState();
  }

  /// (Re)loads the newest page, replacing what is shown, then marks the conversation read.
  Future<void> load() async {
    if (!ref.mounted) return;
    if (state.error != null) state = state.copyWith(isLoading: true, clearError: true);
    try {
      final page = await _client.listMessages(conversationId, limit: chatPageSize);
      if (!ref.mounted) return;
      state = state.copyWith(
        messages: mergeMessages(const [], page.messages),
        hasMore: page.hasMore,
        isLoading: false,
        clearError: true,
      );
      unawaited(_markRead());
    } on Object catch (error) {
      if (!ref.mounted) return;
      state = state.copyWith(isLoading: false, error: error);
    }
  }

  /// Starts polling every [chatPollIntervalProvider]. No-op if already running.
  void startPolling() {
    if (_pollTimer != null) return;
    _pollTimer = Timer.periodic(ref.read(chatPollIntervalProvider), (_) => poll());
  }

  void stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  /// Fetches messages newer than the latest one shown and merges them in (no duplicates, even
  /// if the server's `since` is inclusive or a just-sent message arrives both ways). Marks the
  /// conversation read when something from the other side arrived. Failures are swallowed — the
  /// next tick tries again.
  Future<void> poll() async {
    if (_polling || state.isLoading || state.error != null || !ref.mounted) return;
    _polling = true;
    try {
      final page = await _client.listMessages(
        conversationId,
        limit: chatPageSize,
        since: state.latestCreatedAt,
      );
      if (!ref.mounted || page.messages.isEmpty) return;
      final known = {for (final message in state.messages) message.id};
      final fresh = page.messages.where((message) => !known.contains(message.id)).toList();
      if (fresh.isEmpty) return;
      final me = ref.read(messagingUserIdProvider);
      // A message of ours the poll saw before its POST answered: drop the matching in-flight
      // bubble now rather than show it twice until the POST resolves.
      final pending = state.pending.toList();
      for (final message in fresh.where((message) => message.senderId == me)) {
        final index = pending.indexWhere(
          (p) =>
              p.status == PendingStatus.sending &&
              p.body == message.body &&
              p.images.length == message.attachments.length,
        );
        if (index >= 0) pending.removeAt(index);
      }
      state = state.copyWith(messages: mergeMessages(state.messages, fresh), pending: pending);
      if (fresh.any((message) => message.senderId != me)) unawaited(_markRead());
    } on Object {
      // Transient; keep what is shown.
    } finally {
      _polling = false;
    }
  }

  /// Prepends the page before the oldest message shown. No-op while one is in flight or when
  /// there is nothing older.
  Future<void> loadOlder() async {
    if (!state.hasMore || state.isLoadingOlder || state.messages.isEmpty) return;
    state = state.copyWith(isLoadingOlder: true);
    try {
      final page = await _client.listMessages(
        conversationId,
        limit: chatPageSize,
        before: state.messages.first.id,
      );
      if (!ref.mounted) return;
      state = state.copyWith(
        messages: mergeMessages(state.messages, page.messages),
        hasMore: page.hasMore,
        isLoadingOlder: false,
      );
    } on Object {
      if (!ref.mounted) return;
      state = state.copyWith(isLoadingOlder: false);
    }
  }

  /// Re-fetches the loaded messages (up to the endpoint's page limit, newest first) so their
  /// images get fresh pre-signed `download_url`s — called when an image fails to load, which is
  /// usually its five-minute URL having expired. At most once per [attachmentRefreshCooldown].
  Future<void> refreshAttachments() async {
    if (_refreshingAttachments || state.isLoading || state.messages.isEmpty || !ref.mounted) {
      return;
    }
    final now = ref.read(chatClockProvider)();
    final last = _lastAttachmentRefresh;
    if (last != null && now.difference(last).abs() < attachmentRefreshCooldown) return;
    _lastAttachmentRefresh = now;
    _refreshingAttachments = true;
    try {
      final page = await _client.listMessages(
        conversationId,
        limit: math.min(math.max(state.messages.length, chatPageSize), _maxPageSize),
      );
      if (!ref.mounted) return;
      state = state.copyWith(messages: mergeMessages(state.messages, page.messages));
    } on Object {
      // Transient; the images keep their placeholders until the next attempt.
    } finally {
      _refreshingAttachments = false;
    }
  }

  /// Records the block flags the conversation was opened with, unless this chat has already
  /// learned newer ones.
  void seedBlock(BlockState block) {
    if (state.block == null) state = state.copyWith(block: block);
  }

  /// Takes newer block flags (from the profile, or a report that also blocked).
  void applyBlockState(BlockState block) {
    if (!ref.mounted || state.block == block) return;
    state = state.copyWith(block: block);
  }

  /// Blocks the other participant. Throws on failure, leaving the state unchanged.
  Future<void> block() async {
    final block = await _client.block(conversationId);
    applyBlockState(block);
  }

  /// Removes the caller's block. Throws on failure, leaving the state unchanged.
  Future<void> unblock() async {
    await _client.unblock(conversationId);
    applyBlockState((state.block ?? BlockState.none).copyWith(blockedByMe: false));
  }

  /// Sends [text] (trimmed, otherwise raw — the server does the HTML escaping) with any already
  /// uploaded [images]. Shown at once as a pending message; replaced by the server's copy on
  /// success, marked failed (retryable, with the same storage keys) on error. A message with
  /// neither text nor images, over-long text or too many images is ignored.
  Future<void> send(String text, {List<PendingImage> images = const []}) async {
    final body = text.trim();
    if (body.isEmpty && images.isEmpty) return;
    if (body.length > maxMessageLength || images.length > maxMessageAttachments) return;
    final pending = PendingMessage(
      localId: 'local-${_localSeq++}',
      body: body,
      createdAt: ref.read(chatClockProvider)(),
      status: PendingStatus.sending,
      images: images,
    );
    state = state.copyWith(pending: [...state.pending, pending]);
    await _deliver(pending);
  }

  /// Re-sends a failed pending message.
  Future<void> retry(String localId) async {
    final pending = _pendingById(localId);
    if (pending == null || pending.status != PendingStatus.failed) return;
    _replacePending(pending.copyWith(status: PendingStatus.sending));
    await _deliver(pending);
  }

  /// Drops a failed pending message without sending it.
  void discard(String localId) {
    state = state.copyWith(
      pending: [
        for (final pending in state.pending)
          if (pending.localId != localId) pending,
      ],
    );
  }

  Future<void> _deliver(PendingMessage pending) async {
    try {
      final sent = await _client.sendMessage(
        conversationId,
        pending.body,
        storageKeys: [for (final image in pending.images) image.storageKey],
      );
      if (!ref.mounted) return;
      state = state.copyWith(
        messages: mergeMessages(state.messages, [sent]),
        pending: [
          for (final other in state.pending)
            if (other.localId != pending.localId) other,
        ],
      );
    } on Object catch (error) {
      if (!ref.mounted) return;
      final failure = pendingFailureOf(error);
      _replacePending(pending.copyWith(status: PendingStatus.failed, failure: failure));
      if (failure == PendingFailure.blocked) {
        // A block we did not know about. The other side is the likely one (our own block hides
        // the composer); show that now and confirm against the server.
        applyBlockState((state.block ?? BlockState.none).copyWith(hasBlockedMe: true));
        unawaited(_refreshBlock());
      }
    }
  }

  Future<void> _refreshBlock() async {
    try {
      final conversation = await _client.getConversation(conversationId);
      if (conversation.block.isBlocked) applyBlockState(conversation.block);
    } on Object {
      // Keep the optimistic flags.
    }
  }

  PendingMessage? _pendingById(String localId) {
    for (final pending in state.pending) {
      if (pending.localId == localId) return pending;
    }
    return null;
  }

  void _replacePending(PendingMessage updated) {
    state = state.copyWith(
      pending: [
        for (final pending in state.pending) pending.localId == updated.localId ? updated : pending,
      ],
    );
  }

  Future<void> _markRead() async {
    try {
      await _client.markRead(conversationId);
    } on Object {
      // Best-effort: the badge simply stays until the next successful read.
    }
  }
}

final chatControllerProvider = NotifierProvider.autoDispose
    .family<ChatController, ChatState, String>(ChatController.new);
