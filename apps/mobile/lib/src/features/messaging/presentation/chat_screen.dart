import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/chat_draft_controller.dart';
import '../application/messaging_providers.dart';
import '../domain/chat_state.dart';
import '../domain/draft_attachment.dart';
import '../domain/messaging.dart';
import 'chat_actions.dart';
import 'widgets/chat_bubble.dart';
import 'widgets/chat_composer.dart';
import 'widgets/chat_image.dart';
import 'widgets/conversation_tile.dart';
import 'widgets/participant_profile_sheet.dart';

/// Pushes the chat for [conversation] and, once it is closed, re-fetches the conversation lists
/// (previews, unread counts, the tab badge) so they reflect what was read and sent.
Future<void> openChat(
  BuildContext context,
  WidgetRef ref, {
  required Conversation conversation,
  required MessagingViewer viewer,
}) async {
  await Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => ChatScreen(conversation: conversation, viewer: viewer),
    ),
  );
  if (context.mounted) await refreshConversations(ref);
}

/// One parent ↔ teacher conversation, shared by both roles.
///
/// The app bar's avatar + name open the other participant's profile; its overflow menu holds
/// View profile / Report / Block (or Unblock). Images are attached from the composer and
/// uploaded as soon as they are picked. While either side has blocked the other the composer
/// is replaced by a banner (with Unblock when the block is ours).
///
/// Polls for new messages every [chatPollIntervalProvider] only while this screen is open and
/// the app is in the foreground: polling starts after the first frame, stops when the app is
/// paused / hidden and resumes (with an immediate catch-up poll) when it returns, and stops for
/// good on dispose. The list is reversed, so it opens at — and stays pinned to — the newest
/// message; scrolling up to the oldest loads the page before it.
class ChatScreen extends ConsumerStatefulWidget {
  const ChatScreen({required this.conversation, required this.viewer, super.key});

  final Conversation conversation;
  final MessagingViewer viewer;

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> with WidgetsBindingObserver {
  final _scrollController = ScrollController();

  /// Captured once the provider is live, so [dispose] can stop polling without touching `ref`.
  ChatController? _controller;

  /// How close to the oldest loaded message (in pixels) scrolling must get to load older ones.
  static const _loadOlderThreshold = 240.0;

  String get _conversationId => widget.conversation.id;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scrollController.addListener(_onScroll);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final controller = ref.read(chatControllerProvider(_conversationId).notifier)
        ..seedBlock(widget.conversation.block);
      _controller = controller;
      if (_isForeground(WidgetsBinding.instance.lifecycleState)) _controller!.startPolling();
    });
  }

  @override
  void dispose() {
    _controller?.stopPolling();
    WidgetsBinding.instance.removeObserver(this);
    _scrollController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final controller = _controller;
    if (controller == null) return;
    if (state == AppLifecycleState.resumed) {
      controller
        ..poll()
        ..startPolling();
    } else if (!_isForeground(state)) {
      controller.stopPolling();
    }
  }

  /// `inactive` (a system sheet over the app, an incoming call banner) still counts: the chat
  /// is on screen. Only paused / hidden / detached stop the poll.
  static bool _isForeground(AppLifecycleState? state) =>
      state == null || state == AppLifecycleState.resumed || state == AppLifecycleState.inactive;

  void _onScroll() {
    final position = _scrollController.position;
    if (position.pixels >= position.maxScrollExtent - _loadOlderThreshold) {
      ref.read(chatControllerProvider(_conversationId).notifier).loadOlder();
    }
  }

  void _send(String text) {
    final images = ref.read(chatDraftControllerProvider(_conversationId).notifier).takeUploaded();
    ref.read(chatControllerProvider(_conversationId).notifier).send(text, images: images);
    if (_scrollController.hasClients && _scrollController.offset > 0) {
      _scrollController.animateTo(
        0,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    }
  }

  String get _counterpartName => widget.conversation.counterpart(widget.viewer).name;

  void _showSnack(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _openProfile() => showParticipantProfileSheet(
    context,
    conversation: widget.conversation,
    viewer: widget.viewer,
  );

  void _report({String? messageId, required BlockState block}) => reportConversation(
    context,
    ref,
    conversationId: _conversationId,
    name: _counterpartName,
    messageId: messageId,
    canBlock: !block.blockedByMe,
  );

  void _onMenu(_ChatMenuAction action, BlockState block) {
    switch (action) {
      case _ChatMenuAction.profile:
        _openProfile();
      case _ChatMenuAction.report:
        _report(block: block);
      case _ChatMenuAction.block:
        confirmAndBlock(context, ref, conversationId: _conversationId, name: _counterpartName);
      case _ChatMenuAction.unblock:
        unblockConversation(context, ref, conversationId: _conversationId, name: _counterpartName);
    }
  }

  Future<void> _attach() async {
    final draft = ref.read(chatDraftControllerProvider(_conversationId).notifier);
    if (draft.remaining <= 0) {
      _showSnack('messaging.attachments.tooMany'.tr());
      return;
    }
    final source = await showModalBottomSheet<_ImageSource>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: Text('messaging.attachments.gallery'.tr()),
              onTap: () => Navigator.of(context).pop(_ImageSource.gallery),
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: Text('messaging.attachments.camera'.tr()),
              onTap: () => Navigator.of(context).pop(_ImageSource.camera),
            ),
          ],
        ),
      ),
    );
    if (source == null || !mounted) return;
    final picker = ref.read(chatImagePickerProvider);
    final List<PickedImage> picked;
    try {
      picked = switch (source) {
        _ImageSource.gallery => await picker.pickFromGallery(limit: draft.remaining),
        _ImageSource.camera => [?await picker.takePhoto()],
      };
    } on PlatformException catch (error) {
      // iOS does not ask again once camera access was declined; image_picker throws instead.
      if (!mounted) return;
      _showSnack(
        source == _ImageSource.camera
            ? (error.code == 'camera_access_denied'
                  ? 'messaging.attachments.cameraDenied'.tr()
                  : 'messaging.attachments.cameraError'.tr())
            : 'messaging.attachments.pickError'.tr(),
      );
      return;
    }
    if (!mounted || picked.isEmpty) return;
    final rejections = draft.add(picked);
    if (rejections.isNotEmpty) {
      _showSnack(
        rejections
            .map(
              (rejection) => switch (rejection) {
                AttachmentRejection.unsupportedType => 'messaging.attachments.unsupportedType',
                AttachmentRejection.tooLarge => 'messaging.attachments.tooLarge',
                AttachmentRejection.tooMany => 'messaging.attachments.tooMany',
              }.tr(),
            )
            .join('\n'),
      );
    }
  }

  /// A snackbar when a draft image's upload newly fails, saying why.
  void _onDraftChanged(List<DraftAttachment>? previous, List<DraftAttachment> next) {
    final failedBefore = {
      for (final attachment in previous ?? const <DraftAttachment>[])
        if (attachment.status == DraftUploadStatus.failed) attachment.localId,
    };
    for (final attachment in next) {
      if (attachment.status != DraftUploadStatus.failed ||
          failedBefore.contains(attachment.localId)) {
        continue;
      }
      _showSnack(switch (attachment.failure) {
        PendingFailure.quotaExceeded => 'messaging.attachments.quotaExceeded'.tr(),
        PendingFailure.storageUnavailable => 'messaging.attachments.storageUnavailable'.tr(),
        PendingFailure.invalid => 'messaging.attachments.unsupportedType'.tr(),
        PendingFailure.rateLimited => 'messaging.attachments.rateLimited'.tr(),
        _ => 'messaging.attachments.uploadFailed'.tr(),
      });
      return;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final conversation = widget.conversation;
    final state = ref.watch(chatControllerProvider(_conversationId));
    final controller = ref.read(chatControllerProvider(_conversationId).notifier);
    final drafts = ref.watch(chatDraftControllerProvider(_conversationId));
    final draftController = ref.read(chatDraftControllerProvider(_conversationId).notifier);
    ref.listen(chatDraftControllerProvider(_conversationId), _onDraftChanged);
    final me = ref.watch(messagingUserIdProvider);
    final selfId = conversation.self(widget.viewer).id;
    final block = state.block ?? conversation.block;
    final name = _counterpartName;

    final Widget bottom;
    if (block.blockedByMe) {
      bottom = _BlockedBanner(
        message: 'messaging.block.blockedBanner'.tr(namedArgs: {'name': name}),
        actionLabel: 'messaging.block.unblock'.tr(),
        onAction: () =>
            unblockConversation(context, ref, conversationId: _conversationId, name: name),
      );
    } else if (block.hasBlockedMe) {
      bottom = _BlockedBanner(message: 'messaging.block.blockedByThem'.tr());
    } else {
      bottom = ChatComposer(
        onSend: _send,
        showAttach: true,
        attachments: drafts,
        onAttach: drafts.length >= maxMessageAttachments ? null : _attach,
        onRemoveAttachment: draftController.remove,
        onRetryAttachment: draftController.retry,
      );
    }

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Semantics(
          button: true,
          label: 'messaging.chat.openProfile'.tr(namedArgs: {'name': name}),
          excludeSemantics: true,
          child: InkWell(
            onTap: _openProfile,
            borderRadius: BorderRadius.circular(AppSpacing.space8),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
              child: Row(
                children: [
                  MessagingAvatar(name: name, size: 36),
                  const SizedBox(width: AppSpacing.space12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
                        Text(
                          'messaging.chat.about'.tr(
                            namedArgs: {'student': conversation.student.name},
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        actions: [
          PopupMenuButton<_ChatMenuAction>(
            tooltip: 'messaging.chat.moreActions'.tr(),
            icon: const Icon(Icons.more_vert),
            onSelected: (action) => _onMenu(action, block),
            itemBuilder: (context) => [
              _menuItem(
                _ChatMenuAction.profile,
                icon: Icons.person_outline,
                label: 'messaging.chat.viewProfile'.tr(),
              ),
              const PopupMenuDivider(),
              _menuItem(
                _ChatMenuAction.report,
                icon: Icons.flag_outlined,
                label: 'messaging.chat.report'.tr(namedArgs: {'name': name}),
                destructive: true,
              ),
              if (block.blockedByMe)
                _menuItem(
                  _ChatMenuAction.unblock,
                  icon: Icons.lock_open_outlined,
                  label: 'messaging.chat.unblock'.tr(),
                )
              else
                _menuItem(
                  _ChatMenuAction.block,
                  icon: Icons.block,
                  label: 'messaging.chat.block'.tr(),
                  destructive: true,
                ),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: _ChatBody(
              state: state,
              conversationId: _conversationId,
              isMine: (senderId) => senderId == me || senderId == selfId,
              now: ref.watch(chatClockProvider)(),
              scrollController: _scrollController,
              onRetryLoad: controller.load,
              onRetrySend: controller.retry,
              onImageError: controller.refreshAttachments,
              onReportMessage: (messageId) => _report(messageId: messageId, block: block),
            ),
          ),
          bottom,
        ],
      ),
    );
  }
}

/// An overflow-menu row: leading icon + label, both in the error colour when [destructive]
/// (Report / Block) so the safe action reads apart from the ones that affect the other person.
PopupMenuItem<_ChatMenuAction> _menuItem(
  _ChatMenuAction value, {
  required IconData icon,
  required String label,
  bool destructive = false,
}) {
  return PopupMenuItem(
    value: value,
    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16),
    child: Builder(
      builder: (context) {
        final colors = Theme.of(context).colorScheme;
        final color = destructive ? colors.error : colors.onSurface;
        return Row(
          children: [
            Icon(icon, size: 20, color: destructive ? colors.error : colors.onSurfaceVariant),
            const SizedBox(width: AppSpacing.space12),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: color),
              ),
            ),
          ],
        );
      },
    ),
  );
}

enum _ChatMenuAction { profile, report, block, unblock }

enum _ImageSource { gallery, camera }

/// Takes the composer's place while messaging is blocked: why, and (for our own block) Unblock.
class _BlockedBanner extends StatelessWidget {
  const _BlockedBanner({required this.message, this.actionLabel, this.onAction});

  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    return SafeArea(
      top: false,
      minimum: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space12,
          AppSpacing.space8,
          AppSpacing.space12,
          AppSpacing.space4,
        ),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colorScheme.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(AppSpacing.space16),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.space16,
              vertical: AppSpacing.space12,
            ),
            child: Row(
              children: [
                Icon(Icons.block, size: 20, color: colorScheme.onSurfaceVariant),
                const SizedBox(width: AppSpacing.space12),
                Expanded(
                  child: Text(
                    message,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
                if (actionLabel case final label?) ...[
                  const SizedBox(width: AppSpacing.space8),
                  FilledButton.tonal(onPressed: onAction, child: Text(label)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ChatBody extends StatelessWidget {
  const _ChatBody({
    required this.state,
    required this.conversationId,
    required this.isMine,
    required this.now,
    required this.scrollController,
    required this.onRetryLoad,
    required this.onRetrySend,
    required this.onImageError,
    required this.onReportMessage,
  });

  final ChatState state;
  final String conversationId;
  final bool Function(String senderId) isMine;
  final DateTime now;
  final ScrollController scrollController;
  final VoidCallback onRetryLoad;
  final ValueChanged<String> onRetrySend;
  final VoidCallback onImageError;
  final ValueChanged<String> onReportMessage;

  @override
  Widget build(BuildContext context) {
    if (state.isLoading) return const Center(child: CircularProgressIndicator());
    if (state.error != null) return _LoadError(onRetry: onRetryLoad);
    if (state.messages.isEmpty && state.pending.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space24),
          child: Text(
            'messaging.chat.empty'.tr(),
            textAlign: TextAlign.center,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
          ),
        ),
      );
    }

    // Built oldest → newest, then read back to front: the list is reversed so offset 0 is the
    // newest message and new arrivals land in view without scrolling.
    final items = _items(context);
    return ListView.builder(
      controller: scrollController,
      reverse: true,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space12,
        vertical: AppSpacing.space8,
      ),
      itemCount: items.length + (state.isLoadingOlder ? 1 : 0),
      itemBuilder: (context, index) {
        if (index == items.length) {
          return const Padding(
            padding: EdgeInsets.all(AppSpacing.space12),
            child: Center(child: CircularProgressIndicator()),
          );
        }
        return items[items.length - 1 - index];
      },
    );
  }

  List<Widget> _items(BuildContext context) {
    final items = <Widget>[];
    DateTime? lastDay;
    void separatorFor(DateTime createdAt) {
      final day = dateOnly(createdAt.toLocal());
      if (day != lastDay) {
        items.add(ChatDaySeparator(day: createdAt, now: now));
        lastDay = day;
      }
    }

    final messages = state.messages;
    for (final (index, message) in messages.indexed) {
      separatorFor(message.createdAt);
      final next = index + 1 < messages.length ? messages[index + 1] : null;
      // Time under the last bubble of a run: the sender changes, a gap of 5+ minutes follows,
      // or it is the newest confirmed message.
      final endsRun =
          next == null ||
          next.senderId != message.senderId ||
          next.createdAt.difference(message.createdAt) >= const Duration(minutes: 5);
      final mine = isMine(message.senderId);
      final images = ChatImage.ofMessage(message);
      items.add(
        ChatBubble(
          key: ValueKey(message.id),
          body: message.body,
          createdAt: message.createdAt,
          isMine: mine,
          showTime: endsRun,
          images: images,
          onImageError: onImageError,
          onOpenImage: (index) => openChatImageViewer(
            context,
            images: images,
            initialIndex: index,
            conversationId: conversationId,
            messageId: message.id,
          ),
          onLongPress: mine ? null : () => _confirmReportMessage(context, message.id),
        ),
      );
    }
    for (final pending in state.pending) {
      separatorFor(pending.createdAt);
      final images = [for (final image in pending.images) ChatImage.file(image.localPath)];
      items.add(
        ChatBubble(
          key: ValueKey(pending.localId),
          body: pending.body,
          createdAt: pending.createdAt,
          isMine: true,
          images: images,
          onOpenImage: (index) => openChatImageViewer(context, images: images, initialIndex: index),
          delivery: switch ((pending.status, pending.failure)) {
            (PendingStatus.sending, _) => BubbleDelivery.sending,
            (PendingStatus.failed, PendingFailure.rateLimited) => BubbleDelivery.rateLimited,
            (PendingStatus.failed, PendingFailure.blocked) => BubbleDelivery.blocked,
            (PendingStatus.failed, PendingFailure.quotaExceeded) => BubbleDelivery.quotaExceeded,
            (PendingStatus.failed, PendingFailure.storageUnavailable) =>
              BubbleDelivery.storageUnavailable,
            (PendingStatus.failed, PendingFailure.invalid) => BubbleDelivery.invalid,
            (PendingStatus.failed, _) => BubbleDelivery.failed,
          },
          onRetry: () => onRetrySend(pending.localId),
        ),
      );
    }
    return items;
  }

  /// Long-press on the other participant's message: a one-item menu sheet ("Report message")
  /// leading to the report sheet for that message.
  Future<void> _confirmReportMessage(BuildContext context, String messageId) async {
    HapticFeedback.selectionClick();
    final report = await showModalBottomSheet<bool>(
      context: context,
      builder: (context) => SafeArea(
        child: ListTile(
          leading: const Icon(Icons.flag_outlined),
          title: Text('messaging.chat.reportMessage'.tr()),
          onTap: () => Navigator.of(context).pop(true),
        ),
      ),
    );
    if (report == true) onReportMessage(messageId);
  }
}

class _LoadError extends StatelessWidget {
  const _LoadError({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space8),
            Text(
              'messaging.chat.error'.tr(),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.space12),
            FilledButton.tonal(onPressed: onRetry, child: Text('messaging.chat.retry'.tr())),
          ],
        ),
      ),
    );
  }
}
