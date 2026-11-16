import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// Aliased: the generated `Notification` model collides with Flutter's own `Notification` widget,
// which `flutter/material.dart` brings into scope here.
import '../../../../core/api/generated/models/notification.dart' as api_models;
import '../../../../core/auth/auth_providers.dart';
import '../../../../core/localization/relative_time.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/parent_providers.dart';

/// One row in any of the parent's notification feeds — the home card's combined feed, the school
/// messages tab, and the attendance alerts tab all render the same tile: title, body (max two
/// lines), how long ago, and a kind-coloured icon badge carrying an unread dot. Tapping an unread
/// row marks it read.
class NotificationFeedTile extends ConsumerWidget {
  const NotificationFeedTile({required this.notification, super.key});

  final api_models.Notification notification;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final isUnread = notification.readAt == null;
    final visual = _visualFor(notification);

    return InkWell(
      onTap: isUnread
          ? () async {
              await ref
                  .read(apiClientProvider)
                  .notifications
                  .markNotificationRead(notificationId: notification.id);
              ref.invalidate(parentNotificationsProvider);
              ref.invalidate(parentCommunicationFeedProvider);
            }
          : null,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Unread: the kind's colour plus a brand dot on the badge's corner; read: muted slate.
            Badge(
              isLabelVisible: isUnread,
              smallSize: 10,
              backgroundColor: colorScheme.primary,
              alignment: AlignmentDirectional.topEnd,
              child: AppIconBadge(
                icon: visual.icon,
                accent: isUnread ? visual.accent : AppAccent.slate,
                size: 36,
              ),
            ),
            const SizedBox(width: AppSpacing.space12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    notification.title,
                    style: textTheme.bodyMedium?.copyWith(
                      fontWeight: isUnread ? FontWeight.w700 : FontWeight.w500,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    notification.body,
                    style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.space8),
            Text(
              relativeTimeLabel(notification.createdAt),
              style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

/// The icon and colour for a notification's kind, read from its type name (grades, attendance,
/// announcements, money, messages); anything else gets the plain bell.
SubjectVisual _visualFor(api_models.Notification notification) {
  final type = notification.notificationType.toString().toLowerCase();
  if (type.contains('grade') || type.contains('report')) {
    return const SubjectVisual(accent: AppAccent.emerald, icon: Icons.school_outlined);
  }
  if (type.contains('attendance') || type.contains('absen')) {
    return const SubjectVisual(accent: AppAccent.amber, icon: Icons.event_busy_outlined);
  }
  if (type.contains('announcement')) {
    return const SubjectVisual(accent: AppAccent.violet, icon: Icons.campaign_outlined);
  }
  if (type.contains('invoice') || type.contains('fee') || type.contains('payment')) {
    return const SubjectVisual(accent: AppAccent.orange, icon: Icons.receipt_long_outlined);
  }
  if (type.contains('message')) {
    return const SubjectVisual(accent: AppAccent.cyan, icon: Icons.chat_bubble_outline);
  }
  return const SubjectVisual(accent: AppAccent.blue, icon: Icons.notifications_none_outlined);
}
