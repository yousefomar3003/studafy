import '../../../core/offline/offline_database.dart';

/// The [OfflineDatabase] cache-entry namespace this store owns, and its single key.
const String _resource = 'parent_selected_child';
const String _key = 'selected';

/// Local-only persistence for the parent home's child-switcher selection.
///
/// It is a UI preference, not a cache of a server resource, so it uses [OfflineDatabase]'s plain
/// read/write pair the same way `QuizProgressStore` does rather than an `OfflineCachedResource`.
/// One row, overwritten on every pick. The database wipes itself on logout
/// (`offline_providers.dart`), so a child id never survives into a different account on a shared
/// device and a single fixed key is enough.
class ParentSelectedChildStore {
  ParentSelectedChildStore(this._database);

  final OfflineDatabase _database;

  /// The last child id the parent selected on this device, or null if they never have.
  Future<String?> load() async {
    final row = await _database.read(resource: _resource, cacheKey: _key);
    return row?.payload;
  }

  Future<void> save(String studentId) {
    return _database.write(
      resource: _resource,
      cacheKey: _key,
      payload: studentId,
      fetchedAt: DateTime.now().toUtc(),
    );
  }
}
