import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../../parent/presentation/widgets/child_detail_placeholders.dart';
import '../application/messaging_providers.dart';
import '../domain/messaging.dart';
import 'widgets/conversation_tile.dart';

/// "New message" for a parent: the teachers of one child. Tapping a teacher resolves the
/// conversation with them — the existing one when there is one, else a newly created one
/// (`POST /conversations` is get-or-create either way) — and pops with it; [openContacts] then
/// opens the chat, so closing the chat lands back on the conversation list.
class MessagingContactsScreen extends ConsumerStatefulWidget {
  const MessagingContactsScreen({required this.studentId, required this.studentName, super.key});

  final String studentId;
  final String studentName;

  @override
  ConsumerState<MessagingContactsScreen> createState() => _MessagingContactsScreenState();
}

class _MessagingContactsScreenState extends ConsumerState<MessagingContactsScreen> {
  /// The teacher whose conversation is being opened, to show progress on that row and ignore
  /// further taps meanwhile.
  String? _openingTeacherId;

  Future<void> _open(MessagingContact contact) async {
    if (_openingTeacherId != null) return;
    setState(() => _openingTeacherId = contact.teacherId);
    final client = ref.read(messagingClientProvider);
    try {
      final existing = contact.conversationId;
      final conversation = existing != null
          ? await client.getConversation(existing)
          : await client.startConversation(
              studentId: widget.studentId,
              teacherId: contact.teacherId,
            );
      if (!mounted) return;
      Navigator.of(context).pop(conversation);
    } on Object {
      if (!mounted) return;
      setState(() => _openingTeacherId = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('messaging.contacts.startError'.tr())));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final contacts = ref.watch(messagingContactsProvider(widget.studentId));

    Future<void> onRefresh() async {
      ref.invalidate(messagingContactsProvider(widget.studentId));
      try {
        await ref.read(messagingContactsProvider(widget.studentId).future);
      } on Object {
        // Surfaced by the list itself.
      }
    }

    return Scaffold(
      appBar: AppBar(title: Text('messaging.contacts.title'.tr())),
      body: RefreshIndicator(
        onRefresh: onRefresh,
        child: contacts.when(
          loading: () => const ChildDetailSkeleton(),
          error: (_, _) => const ChildDetailMessage(
            messageKey: 'messaging.contacts.error',
            icon: Icons.error_outline,
          ),
          data: (list) {
            if (list.isEmpty) {
              return const ChildDetailMessage(
                messageKey: 'messaging.contacts.empty',
                icon: Icons.person_search_outlined,
              );
            }
            return ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.space16,
                    AppSpacing.space16,
                    AppSpacing.space16,
                    AppSpacing.space8,
                  ),
                  child: Text(
                    'messaging.contacts.subtitle'.tr(namedArgs: {'name': widget.studentName}),
                    style: theme.textTheme.titleSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
                for (final contact in list)
                  ListTile(
                    leading: MessagingAvatar(name: contact.name),
                    title: Text(contact.name),
                    subtitle: contact.classes.isEmpty
                        ? null
                        : Text(
                            contact.classes.map((klass) => klass.label).join(' · '),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                    trailing: _openingTeacherId == contact.teacherId
                        ? const SizedBox.square(
                            dimension: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Icon(
                            contact.conversationId != null
                                ? Icons.chat_bubble_outline
                                : Icons.chevron_right,
                          ),
                    onTap: _openingTeacherId == null ? () => _open(contact) : null,
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}
