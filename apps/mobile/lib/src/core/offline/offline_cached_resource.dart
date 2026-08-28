import 'dart:convert';

import 'cached_value.dart';
import 'offline_database.dart';

/// Cache-aside access to one kind of API resource, backed by [OfflineDatabase].
///
/// This is the one place the "serve cache, refresh in the background, reconcile" policy lives —
/// each domain repository (`timetable_offline_repository.dart`, etc.) is a thin adapter that
/// supplies the JSON codec and the network call for its own resource, so none of them re-implement
/// this policy themselves.
class OfflineCachedResource<T> {
  OfflineCachedResource({
    required OfflineDatabase database,
    required String resource,
    required Object? Function(T value) encode,
    required T Function(Object? json) decode,
  }) : _database = database,
       _resource = resource,
       _encode = encode,
       _decode = decode;

  final OfflineDatabase _database;
  final String _resource;
  final Object? Function(T value) _encode;
  final T Function(Object? json) _decode;

  /// The cached value for [cacheKey], or null if nothing has ever been cached for it.
  Future<CachedValue<T>?> peek(String cacheKey) async {
    final row = await _database.read(resource: _resource, cacheKey: cacheKey);
    if (row == null) return null;
    return CachedValue(
      data: _decode(jsonDecode(row.payload)),
      fetchedAt: row.fetchedAt,
      source: CacheSource.cache,
    );
  }

  /// Calls [fetch] and, on success, caches and returns its result. On failure, falls back to
  /// [peek] — the cache reconciles on the next successful call. Rethrows [fetch]'s error when
  /// there is nothing cached to fall back to.
  Future<CachedValue<T>> refresh(String cacheKey, Future<T> Function() fetch) async {
    try {
      final data = await fetch();
      final fetchedAt = DateTime.now().toUtc();
      await _database.write(
        resource: _resource,
        cacheKey: cacheKey,
        payload: jsonEncode(_encode(data)),
        fetchedAt: fetchedAt,
      );
      return CachedValue(data: data, fetchedAt: fetchedAt, source: CacheSource.network);
    } catch (error) {
      final cached = await peek(cacheKey);
      if (cached != null) return cached;
      rethrow;
    }
  }

  /// The offline-first read: yields the cached value immediately (if any) so the UI has
  /// something to show right away, then yields the outcome of [refresh] — the background refresh
  /// that reconciles the cache against the server.
  Stream<CachedValue<T>> sync(String cacheKey, Future<T> Function() fetch) async* {
    final cached = await peek(cacheKey);
    if (cached != null) yield cached;
    yield await refresh(cacheKey, fetch);
  }
}
