import '../api/fetch_all_pages.dart';
import '../api/generated/models/timetable_settings.dart';
import '../api/generated/models/timetable_slot.dart';
import '../api/generated/timetable/timetable_client.dart';
import 'cached_value.dart';
import 'offline_cached_resource.dart';
import 'offline_database.dart';

/// Offline-cached timetable data: one timetable version's slots at a time, plus the school's
/// teaching-week settings (which weekdays are school days, in display order).
class TimetableOfflineRepository {
  TimetableOfflineRepository({
    required OfflineDatabase database,
    required TimetableClient client,
  }) : _client = client,
       _slotsCache = OfflineCachedResource<List<TimetableSlot>>(
         database: database,
         resource: 'timetable_slots',
         encode: (slots) => slots.map((slot) => slot.toJson()).toList(),
         decode: (json) => (json as List<Object?>)
             .map(
               (slot) => TimetableSlot.fromJson(slot as Map<String, Object?>),
             )
             .toList(),
       ),
       _settingsCache = OfflineCachedResource<TimetableSettings>(
         database: database,
         resource: 'timetable_settings',
         encode: (settings) => settings.toJson(),
         decode: (json) =>
             TimetableSettings.fromJson(json! as Map<String, Object?>),
       );

  /// The settings are one row per school, and the cache is wiped on sign-out, so a fixed key is
  /// enough — there is never a second school's settings cached alongside.
  static const _settingsCacheKey = 'school';

  final TimetableClient _client;
  final OfflineCachedResource<List<TimetableSlot>> _slotsCache;
  final OfflineCachedResource<TimetableSettings> _settingsCache;

  /// Slots for [versionId], served from cache first and reconciled against the server. A
  /// timetable version can hold a few hundred slots (one per class period per week), more than the
  /// API's 100-row page cap, so every page is fetched. See
  /// [OfflineCachedResource.sync] for [cacheFirst].
  Stream<CachedValue<List<TimetableSlot>>> slotsForVersion(
    String versionId, {
    bool cacheFirst = true,
  }) {
    return _slotsCache.sync(versionId, () async {
      return fetchAllPages((limit, offset) async {
        final page = await _client.listTimetableSlots(
          versionId: versionId,
          limit: limit,
          offset: offset,
        );
        return (rows: page.timetableSlots, total: page.total);
      });
    }, cacheFirst: cacheFirst);
  }

  /// The school's teaching week (`GET /api/academics/timetable-settings`), cache first.
  Stream<CachedValue<TimetableSettings>> settings({bool cacheFirst = true}) {
    return _settingsCache.sync(
      _settingsCacheKey,
      _client.getTimetableSettings,
      cacheFirst: cacheFirst,
    );
  }
}
