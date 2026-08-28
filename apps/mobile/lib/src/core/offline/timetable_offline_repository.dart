import '../api/generated/models/timetable_slot.dart';
import '../api/generated/timetable/timetable_client.dart';
import 'cached_value.dart';
import 'offline_cached_resource.dart';
import 'offline_database.dart';

/// Offline-cached timetable slots, one class's timetable version at a time.
class TimetableOfflineRepository {
  TimetableOfflineRepository({required OfflineDatabase database, required TimetableClient client})
    : _client = client,
      _cache = OfflineCachedResource<List<TimetableSlot>>(
        database: database,
        resource: 'timetable_slots',
        encode: (slots) => slots.map((slot) => slot.toJson()).toList(),
        decode: (json) => (json as List<Object?>)
            .map((slot) => TimetableSlot.fromJson(slot as Map<String, Object?>))
            .toList(),
      );

  final TimetableClient _client;
  final OfflineCachedResource<List<TimetableSlot>> _cache;

  /// Slots for [versionId], served from cache first and reconciled against the server. A
  /// timetable version has at most a few hundred slots (one per class period per week), so a
  /// single page comfortably covers it without needing pagination here.
  Stream<CachedValue<List<TimetableSlot>>> slotsForVersion(String versionId) {
    return _cache.sync(versionId, () async {
      final page = await _client.listTimetableSlots(versionId: versionId, limit: 500);
      return page.timetableSlots;
    });
  }
}
