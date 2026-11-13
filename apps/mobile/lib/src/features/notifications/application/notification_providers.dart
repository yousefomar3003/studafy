import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

// Aliased: the generated `Notification` model collides with Flutter's `Notification` widget.
import '../../../core/api/generated/models/notification.dart' as api_models;
import '../../../core/auth/auth_providers.dart';

/// How often the bell's unread count refreshes on its own while the app is open. A push that
/// arrives in the foreground refreshes it at once (see `NotificationBellButton`).
const unreadCountRefreshInterval = Duration(minutes: 1);

/// The signed-in user's unread notification count, for the bell badge
/// (`GET /api/notifications/unread-count`).
final unreadNotificationsCountProvider = FutureProvider.autoDispose<int>((
  ref,
) async {
  final timer = Timer(unreadCountRefreshInterval, ref.invalidateSelf);
  ref.onDispose(timer.cancel);
  final result = await ref
      .watch(apiClientProvider)
      .notifications
      .getUnreadCount();
  return result.unreadCount;
});

/// One loaded stretch of the inbox: the rows so far and the cursor for the next page.
class NotificationInbox {
  const NotificationInbox({
    required this.items,
    required this.nextCursor,
    this.loadingMore = false,
  });

  final List<api_models.Notification> items;
  final String? nextCursor;
  final bool loadingMore;

  bool get hasMore => nextCursor != null;
  int get unread => items.where((item) => item.readAt == null).length;

  NotificationInbox copyWith({
    List<api_models.Notification>? items,
    String? nextCursor,
    bool clearCursor = false,
    bool? loadingMore,
  }) => NotificationInbox(
    items: items ?? this.items,
    nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
    loadingMore: loadingMore ?? this.loadingMore,
  );
}

/// Rows per page. The API's ceiling is 100; 30 fills a phone screen a few times over.
const notificationPageSize = 30;

/// The signed-in user's notification inbox, newest first (`GET /api/notifications`), with paging
/// and the two read actions. Every change re-reads the bell's unread count.
class NotificationInboxNotifier extends AsyncNotifier<NotificationInbox> {
  @override
  Future<NotificationInbox> build() async {
    final page = await ref
        .watch(apiClientProvider)
        .notifications
        .listNotifications(limit: notificationPageSize);
    return NotificationInbox(
      items: page.notifications,
      nextCursor: page.nextCursor,
    );
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    ref.invalidate(unreadNotificationsCountProvider);
    await future;
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    state = AsyncData(current.copyWith(loadingMore: true));
    try {
      final page = await ref
          .read(apiClientProvider)
          .notifications
          .listNotifications(
            cursor: current.nextCursor,
            limit: notificationPageSize,
          );
      state = AsyncData(
        NotificationInbox(
          items: [...current.items, ...page.notifications],
          nextCursor: page.nextCursor,
        ),
      );
    } catch (_) {
      state = AsyncData(current.copyWith(loadingMore: false));
    }
  }

  /// Marks one notification read, locally at once and then on the server.
  Future<void> markRead(String id) async {
    final current = state.value;
    if (current == null) return;
    final index = current.items.indexWhere((item) => item.id == id);
    if (index < 0 || current.items[index].readAt != null) return;
    state = AsyncData(current.copyWith(items: _withRead(current.items, {id})));
    try {
      await ref
          .read(apiClientProvider)
          .notifications
          .markNotificationRead(notificationId: id);
    } catch (_) {
      // Best effort: the row stays read locally; the next refresh shows the server's truth.
    } finally {
      ref.invalidate(unreadNotificationsCountProvider);
    }
  }

  Future<void> markAllRead() async {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(
        items: _withRead(current.items, current.items.map((i) => i.id).toSet()),
      ),
    );
    try {
      await ref.read(apiClientProvider).notifications.markAllRead();
    } catch (_) {
      // Best effort, as markRead.
    } finally {
      ref.invalidate(unreadNotificationsCountProvider);
    }
  }

  static List<api_models.Notification> _withRead(
    List<api_models.Notification> items,
    Set<String> ids,
  ) {
    final now = DateTime.now().toUtc();
    return [
      for (final item in items)
        if (ids.contains(item.id) && item.readAt == null)
          api_models.Notification(
            id: item.id,
            schoolId: item.schoolId,
            userId: item.userId,
            notificationType: item.notificationType,
            title: item.title,
            body: item.body,
            metadata: item.metadata,
            readAt: now,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          )
        else
          item,
    ];
  }
}

final notificationInboxProvider =
    AsyncNotifierProvider.autoDispose<
      NotificationInboxNotifier,
      NotificationInbox
    >(NotificationInboxNotifier.new);
