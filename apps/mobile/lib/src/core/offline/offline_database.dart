import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

part 'offline_database.g.dart';

/// One cached API response, keyed by [ownerId] (the account that fetched it, the token's `sub`),
/// [resource] (a domain namespace, e.g. `"materials"`) and [cacheKey] (the scope within that
/// namespace, e.g. a class ID) so unrelated scopes of the same resource never collide, and no
/// account ever reads another's row (QA-080). [payload] is the response's own JSON encoding, so
/// this table never needs to know the shape of any particular resource.
@DataClassName('CacheEntryRow')
class CacheEntries extends Table {
  TextColumn get ownerId => text()();
  TextColumn get resource => text()();
  TextColumn get cacheKey => text()();
  TextColumn get payload => text()();
  DateTimeColumn get fetchedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {ownerId, resource, cacheKey};
}

/// The account the cache is currently read and written for, or null while no one is signed in.
typedef OfflineCacheOwner = String? Function();

@DriftDatabase(tables: [CacheEntries])
class OfflineDatabase extends _$OfflineDatabase {
  /// [owner] scopes every read and write to the signed-in account; the app passes the session's
  /// user id (`offline_providers.dart`). Left out, the database is single-tenant, which only tests
  /// and tools that never see two accounts rely on.
  OfflineDatabase([QueryExecutor? executor, OfflineCacheOwner? owner])
    : _owner = owner ?? _singleTenant,
      super(executor ?? _openConnection());

  final OfflineCacheOwner _owner;

  static String _singleTenant() => '';

  @override
  int get schemaVersion => 2;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onUpgrade: (m, from, to) async {
      // v1 rows carry no owner, so nobody can safely claim them: start again from empty. This is a
      // cache; the server reconciles it on the next fetch.
      if (from < 2) {
        await m.deleteTable(cacheEntries.actualTableName);
        await m.createTable(cacheEntries);
      }
    },
  );

  /// The row for [resource]/[cacheKey] written by the current account. Null when it has none, or
  /// when no one is signed in.
  Future<CacheEntryRow?> read({required String resource, required String cacheKey}) async {
    final owner = _owner();
    if (owner == null) return null;
    return (select(cacheEntries)..where(
          (row) =>
              row.ownerId.equals(owner) &
              row.resource.equals(resource) &
              row.cacheKey.equals(cacheKey),
        ))
        .getSingleOrNull();
  }

  /// Caches [payload] for the current account. Nothing is written while no one is signed in.
  Future<void> write({
    required String resource,
    required String cacheKey,
    required String payload,
    required DateTime fetchedAt,
  }) async {
    final owner = _owner();
    if (owner == null) return;
    await into(cacheEntries).insertOnConflictUpdate(
      CacheEntriesCompanion.insert(
        ownerId: owner,
        resource: resource,
        cacheKey: cacheKey,
        payload: payload,
        fetchedAt: fetchedAt,
      ),
    );
  }

  /// Every entry under [resource], oldest write first. The read/write pair above is single-key by
  /// design; the attendance sync queue is the one caller that needs to enumerate a whole
  /// namespace — to drain its outbox — so it lives here rather than as a bespoke query there.
  Future<List<CacheEntryRow>> readAllForResource(String resource) async {
    final owner = _owner();
    if (owner == null) return const [];
    return (select(cacheEntries)
          ..where((row) => row.ownerId.equals(owner) & row.resource.equals(resource))
          ..orderBy([(row) => OrderingTerm(expression: row.fetchedAt)]))
        .get();
  }

  /// Deletes one cache entry, if present. For local-only state that isn't a cache of a server
  /// resource (e.g. `QuizProgressStore`'s in-progress quiz session) — the read/write pair above
  /// has no eviction path of its own since a re-fetch would just repopulate a normal cache entry,
  /// which doesn't apply here.
  Future<void> deleteEntry({required String resource, required String cacheKey}) async {
    final owner = _owner();
    if (owner == null) return;
    await (delete(cacheEntries)..where(
          (row) =>
              row.ownerId.equals(owner) &
              row.resource.equals(resource) &
              row.cacheKey.equals(cacheKey),
        ))
        .go();
  }

  /// Wipes every cached resource. Called on logout — cached school data must not survive into a
  /// different account signing in on the same device. See `offline_providers.dart`.
  Future<void> clearAll() => delete(cacheEntries).go();
}

/// The database lives in the OS cache directory, which neither Android Auto Backup / device
/// transfer nor iCloud backup copy (QA-080): grades and announcements must not travel to a backup
/// and come back on a restore. Earlier builds kept it in Application Support, which is backed up;
/// that copy is deleted on first open.
LazyDatabase _openConnection() {
  return LazyDatabase(() async {
    await deleteLegacyOfflineFiles(await getApplicationSupportDirectory());
    final directory = await getApplicationCacheDirectory();
    final file = File(p.join(directory.path, 'offline_cache.sqlite'));
    return NativeDatabase.createInBackground(file);
  });
}

/// Deletes the offline cache and downloaded materials that earlier builds kept under [support]
/// (Application Support, which OS backups include). Best-effort: a file that can't be deleted now
/// is tried again on the next launch.
Future<void> deleteLegacyOfflineFiles(Directory support) async {
  const files = [
    'offline_cache.sqlite',
    'offline_cache.sqlite-wal',
    'offline_cache.sqlite-shm',
    'offline_cache.sqlite-journal',
  ];
  for (final name in files) {
    try {
      final file = File(p.join(support.path, name));
      if (await file.exists()) await file.delete();
    } on FileSystemException {
      // Retried next launch.
    }
  }
  try {
    final materials = Directory(p.join(support.path, 'materials'));
    if (await materials.exists()) await materials.delete(recursive: true);
  } on FileSystemException {
    // Retried next launch.
  }
}
