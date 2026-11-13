import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/push/push_providers.dart';
import '../../../core/router/route_paths.dart';
import '../application/notification_providers.dart';

/// The app bar's bell: opens the notification inbox, with the unread count as a badge.
///
/// Shown in every role's shell. A push that arrives while the app is open refreshes the badge at
/// once; otherwise it refreshes every [unreadCountRefreshInterval].
class NotificationBellButton extends ConsumerStatefulWidget {
  const NotificationBellButton({super.key});

  @override
  ConsumerState<NotificationBellButton> createState() =>
      _NotificationBellButtonState();
}

class _NotificationBellButtonState
    extends ConsumerState<NotificationBellButton> {
  StreamSubscription<Object?>? _messages;

  @override
  void initState() {
    super.initState();
    _messages = ref.read(pushServiceProvider).onMessage.listen((_) {
      if (mounted) ref.invalidate(unreadNotificationsCountProvider);
    });
  }

  @override
  void dispose() {
    _messages?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final unread = ref.watch(unreadNotificationsCountProvider).value ?? 0;
    final label = unread > 0
        ? 'notifications.bell.unread'.tr(namedArgs: {'count': '$unread'})
        : 'notifications.bell.label'.tr();

    return IconButton(
      key: const Key('notificationBell'),
      tooltip: label,
      onPressed: () async {
        await context.push(RoutePaths.notifications);
        if (mounted) ref.invalidate(unreadNotificationsCountProvider);
      },
      icon: Badge(
        isLabelVisible: unread > 0,
        label: Text(unread > 99 ? '99+' : '$unread'),
        child: Icon(
          unread > 0 ? Icons.notifications : Icons.notifications_none_outlined,
          semanticLabel: label,
        ),
      ),
    );
  }
}
