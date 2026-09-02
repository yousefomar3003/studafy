import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// Aliased: the generated `Notification` model collides with Flutter's own `Notification` widget,
// which `flutter/material.dart` brings into scope here.
import '../../../../core/api/generated/models/notification.dart' as api_models;
import '../../../../core/auth/auth_providers.dart';
import '../../../../core/localization/relative_time.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/parent_providers.dart';
import 'parent_section_card.dart';

/// The combined notifications feed: the most recent notices across every linked child plus
/// account-level ones, unread marked with a leading dot. Tapping one marks it read.
class ParentNotificationsCard extends ConsumerWidget {
  const ParentNotificationsCard({this.maxItems = 6, super.key});

  final int maxItems;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ParentSectionCard(
      titleKey: 'parent.notifications.title',
      icon: Icons.notifications_none_outlined,
      child: ref.watch(parentNotificationsProvider).when(
            loading: () => const ParentCardSkeleton(),
            error: (_, _) => const ParentCardMessage(
              messageKey: 'parent.notifications.error',
              icon: Icons.error_outline,
            ),
            data: (feed) {
              if (feed.isEmpty) {
                return const ParentCardMessage(
                  messageKey: 'parent.notifications.empty',
                  icon: Icons.check_circle_outline,
                );
              }
              return Column(
                children: [
                  for (final notification in feed.take(maxItems))
                    _NotificationRow(notification: notification),
                ],
              );
            },
          ),
    );
  }
}

class _NotificationRow extends ConsumerWidget {
  const _NotificationRow({required this.notification});

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
                    style: textTheme.bodySmall
                        ?.copyWith(color: colorScheme.onSurfaceVariant),
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
