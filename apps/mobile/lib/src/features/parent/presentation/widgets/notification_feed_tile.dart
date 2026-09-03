import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// Aliased: the generated `Notification` model collides with Flutter's own `Notification` widget,
// which `flutter/material.dart` brings into scope here.
import '../../../../core/api/generated/models/notification.dart' as api_models;
import '../../../../core/auth/auth_providers.dart';
import '../../../../core/localization/relative_time.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/parent_providers.dart';

/// One row in any of the parent's notification feeds — the home card's combined feed, the school
/// messages tab, and the attendance alerts tab all render the same tile: title, body (max two
/// lines), how long ago, and an unread dot. Tapping an unread row marks it read.
class NotificationFeedTile extends ConsumerWidget {
  const NotificationFeedTile({required this.notification, super.key});

  final api_models.Notification notification;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final isUnread = notification.readAt == null;

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
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.space4),
              child: Icon(
                Icons.circle,
                size: 8,
                color: isUnread ? colorScheme.primary : Colors.transparent,
              ),
            ),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    notification.title,
                    style: textTheme.bodyMedium?.copyWith(
                      fontWeight: isUnread ? FontWeight.w600 : FontWeight.w400,
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
