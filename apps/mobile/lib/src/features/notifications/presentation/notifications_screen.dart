import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

// Aliased: the generated `Notification` model collides with Flutter's `Notification` widget.
import '../../../core/api/generated/models/notification.dart' as api_models;
import '../../../core/localization/relative_time.dart';
import '../../../core/router/route_paths.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../shell/application/shell_providers.dart';
import '../application/notification_providers.dart';
import '../domain/notification_target.dart';

/// The notification inbox as its own screen, opened from the app bar's bell.
class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasUnread =
        (ref.watch(notificationInboxProvider).value?.unread ?? 0) > 0;
    return Scaffold(
      appBar: AppBar(
        title: Text('notifications.title'.tr()),
        actions: [
          if (hasUnread)
            TextButton(
              key: const Key('notificationsMarkAllRead'),
              onPressed: () =>
                  ref.read(notificationInboxProvider.notifier).markAllRead(),
              child: Text('notifications.markAllRead'.tr()),
            ),
        ],
      ),
      body: const NotificationsInboxView(),
    );
  }
}

/// The inbox list: every notification sent to the signed-in user, newest first. Pull to refresh;
/// tapping one marks it read and opens what it is about, or shows its full text.
///
/// Also the attendance officer's Notifications tab body, inside the shell.
class NotificationsInboxView extends ConsumerWidget {
  const NotificationsInboxView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inbox = ref.watch(notificationInboxProvider);
    final notifier = ref.read(notificationInboxProvider.notifier);

    return RefreshIndicator(
      onRefresh: notifier.refresh,
      child: inbox.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => _Message(
          icon: Icons.cloud_off_outlined,
          text: 'notifications.loadError'.tr(),
          action: TextButton(
            onPressed: notifier.refresh,
            child: Text('notifications.retry'.tr()),
          ),
        ),
        data: (data) {
          if (data.items.isEmpty) {
            return _Message(
              icon: Icons.notifications_none_outlined,
              text: 'notifications.empty'.tr(),
            );
          }
          return ListView.separated(
            key: const Key('notificationsList'),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.symmetric(
              vertical: AppSpacing.space8,
            ).withBottomInset(context),
            itemCount: data.items.length + (data.hasMore ? 1 : 0),
            separatorBuilder: (_, _) => const Divider(height: 1, indent: 56),
            itemBuilder: (context, index) {
              if (index == data.items.length) {
                return Padding(
                  padding: const EdgeInsets.all(AppSpacing.space16),
                  child: Center(
                    child: data.loadingMore
                        ? const CircularProgressIndicator()
                        : OutlinedButton(
                            key: const Key('notificationsLoadMore'),
                            onPressed: notifier.loadMore,
                            child: Text('notifications.loadMore'.tr()),
                          ),
                  ),
                );
              }
              return NotificationTile(notification: data.items[index]);
            },
          );
        },
      ),
    );
  }
}

/// A full-height message (empty or error) that still lets the user pull to refresh.
class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.text, this.action});

  final IconData icon;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(icon, size: 48, color: colorScheme.onSurfaceVariant),
                  const SizedBox(height: AppSpacing.space12),
                  Text(
                    text,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                  if (action != null) ...[
                    const SizedBox(height: AppSpacing.space8),
                    action!,
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

IconData _iconFor(String type) => switch (type) {
  'DIRECT_MESSAGE' || 'SUPPORT_MESSAGE' => Icons.chat_bubble_outline,
  'ATTENDANCE_ALERT' || 'ATTENDANCE_MARKED' => Icons.event_busy_outlined,
  'ANNOUNCEMENT' || 'ADMIN_ANNOUNCEMENT' => Icons.campaign_outlined,
  'ASSIGNMENT_PUBLISHED' || 'ASSIGNMENT_DUE_SOON' => Icons.assignment_outlined,
  'ASSIGNMENT_GRADED' || 'GRADE_POSTED' => Icons.grading_outlined,
  'FEE_INVOICE_ISSUED' ||
  'FEE_PAYMENT_RECEIVED' ||
  'FEE_PAYMENT_REMINDER' ||
  'FEE_STATEMENT' => Icons.receipt_long_outlined,
  _ => Icons.notifications_none_outlined,
};

/// One inbox row: an icon for the kind of notice, title, body, how long ago, and an unread dot.
class NotificationTile extends ConsumerWidget {
  const NotificationTile({required this.notification, super.key});

  final api_models.Notification notification;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final unread = notification.readAt == null;
    final type = notification.notificationType.json ?? '';

    return InkWell(
      key: Key('notification-${notification.id}'),
      onTap: () => _open(context, ref),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space16,
          vertical: AppSpacing.space12,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(
              radius: 18,
              backgroundColor: colorScheme.primaryContainer,
              child: Icon(
                _iconFor(type),
                size: 20,
                color: colorScheme.onPrimaryContainer,
              ),
            ),
            const SizedBox(width: AppSpacing.space12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    notification.title,
                    style: textTheme.bodyLarge?.copyWith(
                      fontWeight: unread ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                  if (notification.body.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.space4),
                    Text(
                      notification.body,
                      style: textTheme.bodyMedium?.copyWith(
                        color: colorScheme.onSurfaceVariant,
                      ),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                  const SizedBox(height: AppSpacing.space4),
                  Text(
                    relativeTimeLabel(notification.createdAt),
                    style: textTheme.bodySmall?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.space8),
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.space8),
              child: Icon(
                Icons.circle,
                size: 10,
                color: unread ? colorScheme.primary : Colors.transparent,
                semanticLabel: unread ? 'notifications.unread'.tr() : null,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context, WidgetRef ref) async {
    unawaited(
      ref.read(notificationInboxProvider.notifier).markRead(notification.id),
    );
    final target = notificationTargetFor(
      type: notification.notificationType.json ?? '',
      metadata: notification.metadata,
      role: ref.read(shellRoleProvider),
    );

    if (target.route != null) {
      await context.push(target.route!);
      return;
    }
    if (target.tabLabelKey != null) {
      ref.read(selectedShellTabProvider.notifier).select(target.tabLabelKey!);
      // Back to the shell, wherever the inbox was opened from.
      if (GoRouter.of(context).canPop()) context.go(RoutePaths.home);
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.space24,
            0,
            AppSpacing.space24,
            AppSpacing.space24,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                notification.title,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: AppSpacing.space8),
              Text(
                relativeTimeLabel(notification.createdAt),
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.space16),
              SelectableText(
                notification.body,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
