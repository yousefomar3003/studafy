import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/messaging_providers.dart';
import '../../domain/messaging.dart';
import '../chat_actions.dart';
import 'conversation_tile.dart';

/// Opens the other participant's profile for [conversation] in a tall bottom sheet.
Future<void> showParticipantProfileSheet(
  BuildContext context, {
  required Conversation conversation,
  required MessagingViewer viewer,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.75,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      builder: (context, scrollController) => ParticipantProfileSheet(
        conversation: conversation,
        viewer: viewer,
        scrollController: scrollController,
      ),
    ),
  );
}

/// The other participant of a conversation, from `GET …/profile`:
/// - a teacher (seen by a parent): role, the classes they teach the thread's child (code ·
///   course · subject) and the subjects they teach as chips;
/// - a parent (seen by a teacher): their relationship to the thread's child, and each of their
///   children the teacher teaches with that child's classes.
///
/// Loading / error-with-retry states, and Block / Unblock and Report actions acting on the open
/// chat (the block state shown is the chat's, so the two stay in step).
class ParticipantProfileSheet extends ConsumerWidget {
  const ParticipantProfileSheet({
    required this.conversation,
    required this.viewer,
    this.scrollController,
    super.key,
  });

  final Conversation conversation;
  final MessagingViewer viewer;
  final ScrollController? scrollController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final conversationId = conversation.id;
    final profile = ref.watch(participantProfileProvider(conversationId));
    ref.listen(participantProfileProvider(conversationId), (_, next) {
      if (next.value case final loaded?) {
        ref.read(chatControllerProvider(conversationId).notifier).applyBlockState(loaded.block);
      }
    });
    final chatBlock = ref.watch(chatControllerProvider(conversationId).select((s) => s.block));
    final block = chatBlock ?? profile.value?.block ?? conversation.block;
    final name = profile.value?.name ?? conversation.counterpart(viewer).name;
    final student = conversation.student.name;

    final children = <Widget>[
      Center(child: MessagingAvatar(name: name, size: 72)),
      const SizedBox(height: AppSpacing.space12),
      Text(
        name,
        textAlign: TextAlign.center,
        style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: AppSpacing.space4),
    ];

    switch (profile) {
      case AsyncData(:final value):
        children.add(
          Text(
            _subtitle(value, student),
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
          ),
        );
        children.addAll(_details(context, value, student));
      case AsyncError():
        children.addAll([
          const SizedBox(height: AppSpacing.space24),
          Icon(Icons.error_outline, color: colorScheme.onSurfaceVariant),
          const SizedBox(height: AppSpacing.space8),
          Text(
            'messaging.profile.error'.tr(),
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: AppSpacing.space12),
          Center(
            child: FilledButton.tonal(
              onPressed: () => ref.invalidate(participantProfileProvider(conversationId)),
              child: Text('messaging.profile.retry'.tr()),
            ),
          ),
        ]);
      default:
        children.addAll(const [
          SizedBox(height: AppSpacing.space32),
          Center(child: CircularProgressIndicator()),
        ]);
    }

    children.addAll([
      const SizedBox(height: AppSpacing.space24),
      const Divider(),
      const SizedBox(height: AppSpacing.space8),
      Row(
        children: [
          Expanded(
            child: OutlinedButton.icon(
              icon: Icon(block.blockedByMe ? Icons.lock_open : Icons.block),
              label: Text(
                block.blockedByMe
                    ? 'messaging.profile.unblock'.tr()
                    : 'messaging.profile.block'.tr(),
              ),
              onPressed: () => block.blockedByMe
                  ? unblockConversation(context, ref, conversationId: conversationId, name: name)
                  : confirmAndBlock(context, ref, conversationId: conversationId, name: name),
            ),
          ),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            child: OutlinedButton.icon(
              style: OutlinedButton.styleFrom(foregroundColor: colorScheme.error),
              icon: const Icon(Icons.flag_outlined),
              label: Text('messaging.profile.report'.tr()),
              onPressed: () async {
                final navigator = Navigator.of(context);
                final done = await reportConversation(
                  context,
                  ref,
                  conversationId: conversationId,
                  name: name,
                  canBlock: !block.blockedByMe,
                );
                // Back to the chat, where the outcome's snackbar is not under a sheet.
                if (done) navigator.pop();
              },
            ),
          ),
        ],
      ),
    ]);

    return ListView(
      controller: scrollController,
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space20,
        0,
        AppSpacing.space20,
        AppSpacing.space24,
      ),
      children: children,
    );
  }

  static String _subtitle(ParticipantProfile profile, String student) => switch (profile.role) {
    ProfileRole.teacher => 'messaging.profile.teacher'.tr(),
    ProfileRole.parent when profile.relationship != null => 'messaging.profile.relationshipTo'.tr(
      namedArgs: {'relationship': relationshipKeyOf(profile.relationship).tr(), 'child': student},
    ),
    ProfileRole.parent => 'messaging.profile.parent'.tr(),
  };

  List<Widget> _details(BuildContext context, ParticipantProfile profile, String student) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    Widget heading(String text) => Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space24, bottom: AppSpacing.space8),
      child: Text(text, style: theme.textTheme.titleSmall),
    );
    Widget muted(String text) => Text(
      text,
      style: theme.textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
    );

    switch (profile.role) {
      case ProfileRole.teacher:
        return [
          heading('messaging.profile.teaches'.tr(namedArgs: {'child': student})),
          if (profile.classes.isEmpty)
            muted('messaging.profile.noClasses'.tr(namedArgs: {'child': student}))
          else
            for (final teacherClass in profile.classes)
              ListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                leading: const Icon(Icons.class_outlined),
                title: Text(teacherClass.label),
              ),
          if (profile.subjects.isNotEmpty) ...[
            heading('messaging.profile.subjects'.tr()),
            Wrap(
              spacing: AppSpacing.space8,
              runSpacing: AppSpacing.space8,
              children: [for (final subject in profile.subjects) Chip(label: Text(subject))],
            ),
          ],
        ];
      case ProfileRole.parent:
        return [
          if (profile.children.isNotEmpty) heading('messaging.profile.children'.tr()),
          for (final child in profile.children)
            Card(
              margin: const EdgeInsets.only(bottom: AppSpacing.space8),
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.space12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            child.name,
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        if (child.isConversationStudent)
                          Chip(
                            visualDensity: VisualDensity.compact,
                            label: Text('messaging.profile.thisConversation'.tr()),
                          ),
                      ],
                    ),
                    Text(
                      relationshipKeyOf(child.relationship).tr(),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.space8),
                    if (child.classes.isEmpty)
                      muted('messaging.profile.noChildClasses'.tr())
                    else
                      for (final childClass in child.classes)
                        Padding(
                          padding: const EdgeInsets.only(top: AppSpacing.space4),
                          child: Text(
                            [
                              childClass.code,
                              ?childClass.courseName,
                            ].where((part) => part.isNotEmpty).join(' · '),
                            style: theme.textTheme.bodyMedium,
                          ),
                        ),
                  ],
                ),
              ),
            ),
        ];
    }
  }
}
