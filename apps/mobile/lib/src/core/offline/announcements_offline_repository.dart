import '../api/generated/announcements/announcements_client.dart';
import '../api/generated/models/announcement.dart';
import 'cached_value.dart';
import 'offline_cached_resource.dart';
import 'offline_database.dart';

/// Offline-cached announcements feed — the newest page only, which is what the mobile shell
/// shows; older announcements are a live-only, online-required drill-down.
class AnnouncementsOfflineRepository {
  AnnouncementsOfflineRepository({
    required OfflineDatabase database,
    required AnnouncementsClient client,
  }) : _client = client,
       _cache = OfflineCachedResource<List<Announcement>>(
         database: database,
         resource: 'announcements',
         encode: (announcements) => announcements.map((announcement) => announcement.toJson()).toList(),
         decode: (json) => (json as List<Object?>)
             .map((announcement) => Announcement.fromJson(announcement as Map<String, Object?>))
             .toList(),
       );

  final AnnouncementsClient _client;
  final OfflineCachedResource<List<Announcement>> _cache;

  static const _feedCacheKey = 'feed';

  /// The newest page of announcements, served from cache first and reconciled against the
  /// server.
  Stream<CachedValue<List<Announcement>>> feed() {
    return _cache.sync(_feedCacheKey, () async {
      final page = await _client.listAnnouncements(limit: 50);
      return page.items;
    });
  }
}
