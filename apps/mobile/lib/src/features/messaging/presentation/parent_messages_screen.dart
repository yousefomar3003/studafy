import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/child_comparison_item.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../parent/application/parent_providers.dart';
import '../../parent/presentation/widgets/child_detail_placeholders.dart';
import '../../parent/presentation/widgets/child_switcher_bar.dart';
import '../../shell/application/shell_providers.dart';
import '../application/messaging_providers.dart';
import '../domain/messaging.dart';
import 'chat_screen.dart';
import 'messaging_contacts_screen.dart';
import 'widgets/conversation_list_view.dart';

/// The shell destination whose (re)selection refreshes the conversation list.
const messagesTabKey = 'shell.tabs.messages';

/// The parent shell's Messages tab: the selected child's conversations with their teachers.
///
/// Scoped through [selectedChildProvider], the same child the Home and Children tabs show; with
/// more than one linked child the chip bar on top switches it. "New message" opens the child's
/// teacher contacts.
class ParentMessagesScreen extends ConsumerWidget {
  const ParentMessagesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(selectedShellTabProvider, (previous, next) {
      if (next == messagesTabKey && previous != next) refreshConversations(ref);
    });

    return ref
        .watch(selectedChildProvider)
        .when(
          loading: () => const ChildDetailSkeleton(),
          error: (_, _) => const ChildDetailMessage(
            messageKey: 'parent.children.error',
            icon: Icons.error_outline,
          ),
          data: (child) => child == null
              ? const ChildDetailMessage(
                  messageKey: 'parent.children.empty',
                  icon: Icons.info_outline,
                )
              : _ChildConversations(child: child),
        );
  }
}

class _ChildConversations extends ConsumerWidget {
  const _ChildConversations({required this.child});

  final ChildComparisonItem child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final children = ref.watch(linkedChildrenProvider).value ?? const <ChildComparisonItem>[];
    final studentId = child.studentId;
    // Contacts carry each teacher's classes for this child; a conversation's row shows them as
    // its context line. Best-effort: without them the row simply has no class line.
    final contacts = ref.watch(messagingContactsProvider(studentId)).value ?? const [];
    final classesByConversation = {
      for (final contact in contacts)
        ?contact.conversationId: contact.classes.map((klass) => klass.label).join(' · '),
    };

    return Scaffold(
      floatingActionButton: Padding(
        padding: EdgeInsets.only(bottom: context.bottomBarOverlap),
        child: FloatingActionButton.extended(
          heroTag: null,
          onPressed: () => openContacts(context, ref, child: child),
          icon: const Icon(Icons.edit_outlined),
          label: Text('messaging.newMessage'.tr()),
        ),
      ),
      body: Column(
        children: [
          if (children.length > 1) ChildSwitcherBar(children: children, selectedId: studentId),
          Expanded(
            child: ConversationListView(
              conversations: ref.watch(conversationsProvider(studentId)),
              viewer: MessagingViewer.parent,
              onRefresh: () async {
                ref.invalidate(messagingContactsProvider(studentId));
                await refreshConversations(ref, studentId: studentId);
              },
              contextLineFor: (conversation) {
                final classes = classesByConversation[conversation.id];
                return classes == null || classes.isEmpty ? null : classes;
              },
              emptyHintKey: 'messaging.list.emptyParentHint',
              emptyHintArgs: {'name': child.studentName},
              bottomPadding: AppSpacing.space80,
            ),
          ),
        ],
      ),
    );
  }
}

/// Pushes the teacher picker for [child]; when a teacher was picked, opens that conversation's
/// chat. The conversation lists refresh once everything is closed.
Future<void> openContacts(
  BuildContext context,
  WidgetRef ref, {
  required ChildComparisonItem child,
}) async {
  final conversation = await Navigator.of(context).push(
    MaterialPageRoute<Conversation>(
      builder: (_) =>
          MessagingContactsScreen(studentId: child.studentId, studentName: child.studentName),
    ),
  );
  if (!context.mounted) return;
  ref.invalidate(messagingContactsProvider(child.studentId));
  if (conversation != null) {
    await openChat(context, ref, conversation: conversation, viewer: MessagingViewer.parent);
  } else {
    await refreshConversations(ref, studentId: child.studentId);
  }
}
