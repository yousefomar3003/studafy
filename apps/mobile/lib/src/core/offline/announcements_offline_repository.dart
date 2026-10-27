import '../api/generated/models/notification.dart';
import '../api/generated/models/notification_notification_type.dart';
import '../api/generated/notifications/notifications_client.dart';
import 'cached_value.dart';
import 'offline_cached_resource.dart';
import 'offline_database.dart';

/// The notification types an announcement fans out as into each recipient's inbox — see
/// `NOTIFICATION_TYPE_FOR` in `packages/announcements/src/index.ts`: mandatory announcements
/// arrive as `ADMIN_ANNOUNCEMENT`, optional ones as `ANNOUNCEMENT`.
const announcementNotificationTypes = {
  NotificationNotificationType.announcement,
  NotificationNotificationType.adminAnnouncement,
};

/// Whether [notification] is the inbox copy of a mandatory (un-optoutable) announcement.
bool isMandatoryAnnouncement(Notification notification) =>
    notification.notificationType == NotificationNotificationType.adminAnnouncement;

/// Offline-cached announcements feed for the signed-in user — the newest inbox page only, which
/// is what the mobile shell shows; older announcements are a live-only, online-required
/// drill-down.
///
/// Sourced from the caller's own notifications inbox (`GET /api/notifications`, which needs no
/// permission beyond being signed in), filtered to [announcementNotificationTypes] — not from
/// `GET /api/announcements`, which is the admin-only compose history gated on
/// `notification:manage` and answers 403 for students, parents and teachers.
class AnnouncementsOfflineRepository {
  AnnouncementsOfflineRepository({
    required OfflineDatabase database,
    required this._client,
  }) : _cache = OfflineCachedResource<List<Notification>>(
         database: database,
         // Distinct from the old `announcements` resource, whose rows hold admin-history
         // `Announcement` JSON that would not decode as a `Notification`.
         resource: 'announcements_inbox',
         encode: (notifications) =>
             notifications.map((notification) => notification.toJson()).toList(),
         decode: (json) => (json as List<Object?>)
             .map((notification) => Notification.fromJson(notification as Map<String, Object?>))
             .toList(),
       );

  final NotificationsClient _client;
  final OfflineCachedResource<List<Notification>> _cache;

  static const _feedCacheKey = 'feed';

  /// The largest page `GET /api/notifications` allows. The inbox mixes every notification kind,
  /// so the widest page gives the announcement filter the most to work with in one request.
  static const _inboxPageSize = 100;

  /// The newest announcements in this user's inbox, newest first, served from cache first and
  /// reconciled against the server.
  Stream<CachedValue<List<Notification>>> feed() {
    return _cache.sync(_feedCacheKey, () async {
      final page = await _client.listNotifications(limit: _inboxPageSize);
      return [
        for (final notification in page.notifications)
          if (announcementNotificationTypes.contains(notification.notificationType)) notification,
      ]..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    });
  }
}
