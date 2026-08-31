import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

part 'offline_database.g.dart';

/// One cached API response, keyed by [resource] (a domain namespace, e.g. `"materials"`) and
/// [cacheKey] (the scope within that namespace, e.g. a class ID) so unrelated scopes of the same
/// resource never collide. [payload] is the response's own JSON encoding, so this table never
/// needs to know the shape of any particular resource.
@DataClassName('CacheEntryRow')
class CacheEntries extends Table {
  TextColumn get resource => text()();
  TextColumn get cacheKey => text()();
  TextColumn get payload => text()();
  DateTimeColumn get fetchedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {resource, cacheKey};
}

@DriftDatabase(tables: [CacheEntries])
class OfflineDatabase extends _$OfflineDatabase {
  OfflineDatabase([QueryExecutor? executor]) : super(executor ?? _openConnection());

  @override
  int get schemaVersion => 1;

  Future<CacheEntryRow?> read({required String resource, required String cacheKey}) {
    return (select(cacheEntries)
          ..where((row) => row.resource.equals(resource) & row.cacheKey.equals(cacheKey)))
        .getSingleOrNull();
  }

  Future<void> write({
    required String resource,
    required String cacheKey,
    required String payload,
    required DateTime fetchedAt,
  }) {
    return into(cacheEntries).insertOnConflictUpdate(
      CacheEntriesCompanion.insert(
        resource: resource,
        cacheKey: cacheKey,
        payload: payload,
        fetchedAt: fetchedAt,
      ),
    );
  }

  /// Deletes one cache entry, if present. For local-only state that isn't a cache of a server
  /// resource (e.g. `QuizProgressStore`'s in-progress quiz session) — the read/write pair above
  /// has no eviction path of its own since a re-fetch would just repopulate a normal cache entry,
  /// which doesn't apply here.
  Future<void> deleteEntry({required String resource, required String cacheKey}) {
    return (delete(cacheEntries)
          ..where((row) => row.resource.equals(resource) & row.cacheKey.equals(cacheKey)))
        .go();
  }

  /// Wipes every cached resource. Called on logout — cached school data must not survive into a
  /// different account signing in on the same device. See `offline_providers.dart`.
  Future<void> clearAll() => delete(cacheEntries).go();
}

LazyDatabase _openConnection() {
  return LazyDatabase(() async {
    final directory = await getApplicationSupportDirectory();
    final file = File(p.join(directory.path, 'offline_cache.sqlite'));
    return NativeDatabase.createInBackground(file);
  });
}
