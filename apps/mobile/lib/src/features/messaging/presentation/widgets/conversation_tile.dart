import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/localization/relative_time.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/messaging.dart';

/// One row of a conversation list: the other party's name, a context line ([contextLine] — the
/// class / course for a parent, `re: <student>` for a teacher), the last message preview, its
/// relative time and an unread badge.
class ConversationTile extends StatelessWidget {
  const ConversationTile({
    required this.conversation,
    required this.viewer,
    required this.myUserId,
    required this.onTap,
    this.contextLine,
    super.key,
  });

  final Conversation conversation;
  final MessagingViewer viewer;
  final String? myUserId;
  final String? contextLine;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final counterpart = conversation.counterpart(viewer);
    final last = conversation.lastMessage;
    final unread = conversation.unreadCount;
    final hasUnread = unread > 0;

    final String preview;
    if (last == null) {
      preview = 'messaging.list.noMessagesYet'.tr();
    } else {
      final body = previewBody(last);
      preview = last.senderId == myUserId || last.senderId == conversation.self(viewer).id
          ? 'messaging.list.you'.tr(namedArgs: {'body': body})
          : body;
    }
    final blocked = conversation.block.isBlocked;

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space16,
          vertical: AppSpacing.space12,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            MessagingAvatar(name: counterpart.name),
            const SizedBox(width: AppSpacing.space12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          counterpart.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: hasUnread ? FontWeight.w700 : FontWeight.w600,
                          ),
                        ),
                      ),
                      if (blocked) ...[
                        const SizedBox(width: AppSpacing.space4),
                        Tooltip(
                          message: 'messaging.list.blocked'.tr(),
                          child: Icon(
                            Icons.block,
                            size: 14,
                            color: colorScheme.onSurfaceVariant,
                            semanticLabel: 'messaging.list.blocked'.tr(),
                          ),
                        ),
                      ],
                      const Spacer(),
                      const SizedBox(width: AppSpacing.space8),
                      Text(
                        relativeTimeLabel(last?.createdAt ?? conversation.updatedAt),
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: hasUnread ? colorScheme.primary : colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                  if (contextLine case final line?) ...[
                    const SizedBox(height: AppSpacing.space4),
                    Text(
                      line,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                  const SizedBox(height: AppSpacing.space4),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          preview,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: hasUnread ? colorScheme.onSurface : colorScheme.onSurfaceVariant,
                            fontWeight: hasUnread ? FontWeight.w600 : null,
                            fontStyle: last == null ? FontStyle.italic : null,
                          ),
                        ),
                      ),
                      if (hasUnread) ...[
                        const SizedBox(width: AppSpacing.space8),
                        Semantics(
                          label: 'messaging.list.unread'.tr(namedArgs: {'count': '$unread'}),
                          excludeSemantics: true,
                          child: Badge.count(
                            count: unread,
                            maxCount: 99,
                            backgroundColor: colorScheme.primary,
                            textColor: colorScheme.onPrimary,
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The preview text for a conversation's newest message: its body, or "📷 Photo(s)" for an
/// image-only one.
String previewBody(ConversationPreview last) {
  if (last.body.isNotEmpty || last.attachmentCount == 0) return last.body;
  return last.attachmentCount == 1 ? 'messaging.list.photo'.tr() : 'messaging.list.photos'.tr();
}

/// A round initials avatar for a person in the messaging screens.
class MessagingAvatar extends StatelessWidget {
  const MessagingAvatar({required this.name, this.size = 44, super.key});

  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colorScheme.primaryContainer,
        borderRadius: AppRadius.fullRadius,
      ),
      child: SizedBox.square(
        dimension: size,
        child: Center(
          child: Text(
            initialsOf(name),
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
              color: colorScheme.onPrimaryContainer,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }
}

/// Up to two initials from [name]'s first and last words ("Rana Haddad" → "RH").
String initialsOf(String name) {
  final words = name.trim().split(RegExp(r'\s+')).where((word) => word.isNotEmpty).toList();
  if (words.isEmpty) return '?';
  final first = words.first.characters.first;
  if (words.length == 1) return first.toUpperCase();
  return (first + words.last.characters.first).toUpperCase();
}
