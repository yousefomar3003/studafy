import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../shell/application/shell_providers.dart';
import '../application/messaging_providers.dart';
import '../domain/messaging.dart';
import 'chat_screen.dart';
import 'parent_messages_screen.dart' show messagesTabKey;
import 'teacher_messaging_contacts_screen.dart';
import 'widgets/conversation_list_view.dart';

/// The teacher shell's Messages tab: every conversation this teacher shares with parents —
/// whichever side started it — newest activity first. "New message" opens the parents of the
/// students the teacher teaches ([TeacherMessagingContactsScreen]).
class TeacherMessagesScreen extends ConsumerWidget {
  const TeacherMessagesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(selectedShellTabProvider, (previous, next) {
      if (next == messagesTabKey && previous != next) refreshConversations(ref);
    });

    return Scaffold(
      floatingActionButton: Padding(
        padding: EdgeInsets.only(bottom: context.bottomBarOverlap),
        child: FloatingActionButton.extended(
          heroTag: null,
          onPressed: () => openTeacherContacts(context, ref),
          icon: const Icon(Icons.edit_outlined),
          label: Text('messaging.newMessage'.tr()),
        ),
      ),
      body: ConversationListView(
        conversations: ref.watch(conversationsProvider(null)),
        viewer: MessagingViewer.teacher,
        onRefresh: () => refreshConversations(ref),
        contextLineFor: (conversation) =>
            'messaging.list.regarding'.tr(namedArgs: {'student': conversation.student.name}),
        emptyHintKey: 'messaging.list.emptyTeacherHint',
        bottomPadding: AppSpacing.space80,
      ),
    );
  }
}

/// Pushes the parent picker; when a parent was picked, opens that conversation's chat. The
/// conversation lists refresh once everything is closed.
Future<void> openTeacherContacts(BuildContext context, WidgetRef ref) async {
  final conversation = await Navigator.of(
    context,
  ).push(MaterialPageRoute<Conversation>(builder: (_) => const TeacherMessagingContactsScreen()));
  if (!context.mounted) return;
  if (conversation != null) {
    await openChat(context, ref, conversation: conversation, viewer: MessagingViewer.teacher);
  } else {
    await refreshConversations(ref);
  }
}
