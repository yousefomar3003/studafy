import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../parent/presentation/widgets/child_detail_placeholders.dart';
import '../../application/messaging_providers.dart';
import '../../domain/messaging.dart';
import '../chat_screen.dart';
import 'conversation_tile.dart';
import '../../../../design/layout/bottom_inset_padding.dart';

/// A pull-to-refresh list of [conversations] with loading / error / empty states, shared by the
/// parent and teacher Messages tabs. Tapping a row opens the chat and refreshes on return.
///
/// [contextLineFor] supplies each row's second line; [emptyHintKey] the empty state's hint.
class ConversationListView extends ConsumerWidget {
  const ConversationListView({
    required this.conversations,
    required this.viewer,
    required this.onRefresh,
    required this.contextLineFor,
    this.emptyHintKey,
    this.emptyHintArgs,
    this.bottomPadding = 0,
    super.key,
  });

  final AsyncValue<List<Conversation>> conversations;
  final MessagingViewer viewer;
  final Future<void> Function() onRefresh;
  final String? Function(Conversation conversation) contextLineFor;
  final String? emptyHintKey;
  final Map<String, String>? emptyHintArgs;

  /// Extra space under the last row, e.g. to clear a floating action button.
  final double bottomPadding;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(messagingUserIdProvider);

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: conversations.when(
        skipLoadingOnRefresh: true,
        loading: () => const ChildDetailSkeleton(),
        error: (_, _) =>
            const ChildDetailMessage(messageKey: 'messaging.list.error', icon: Icons.error_outline),
        data: (list) {
          if (list.isEmpty) {
            return ChildDetailMessage(
              messageKey: 'messaging.list.empty',
              hintKey: emptyHintKey,
              hintArgs: emptyHintArgs,
              icon: Icons.forum_outlined,
            );
          }
          return ListView.separated(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: EdgeInsets.only(bottom: bottomPadding).withBottomInset(context),
            itemCount: list.length,
            separatorBuilder: (_, _) => const Divider(height: 1, indent: 72),
            itemBuilder: (context, index) {
              final conversation = list[index];
              return ConversationTile(
                conversation: conversation,
                viewer: viewer,
                myUserId: me,
                contextLine: contextLineFor(conversation),
                onTap: () => openChat(context, ref, conversation: conversation, viewer: viewer),
              );
            },
          );
        },
      ),
    );
  }
}
