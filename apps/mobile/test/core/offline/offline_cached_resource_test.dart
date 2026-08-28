import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/core/offline/offline_cached_resource.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';

void main() {
  late OfflineDatabase database;
  late OfflineCachedResource<List<String>> cache;

  setUp(() {
    database = OfflineDatabase(NativeDatabase.memory());
    cache = OfflineCachedResource<List<String>>(
      database: database,
      resource: 'widgets',
      encode: (value) => value,
      decode: (json) => (json as List<Object?>).cast<String>(),
    );
  });

  tearDown(() => database.close());

  group('peek', () {
    test('returns null when nothing has ever been cached for the key', () async {
      expect(await cache.peek('missing'), isNull);
    });

    test('returns the cached value tagged as CacheSource.cache', () async {
      await cache.refresh('key', () async => ['a', 'b']);

      final cached = await cache.peek('key');

      expect(cached!.data, ['a', 'b']);
      expect(cached.source, CacheSource.cache);
      expect(cached.isStale, isTrue);
    });
  });

  group('refresh', () {
    test('caches and returns a successful fetch as CacheSource.network', () async {
      final result = await cache.refresh('key', () async => ['fresh']);

      expect(result.data, ['fresh']);
      expect(result.source, CacheSource.network);
      expect(result.isStale, isFalse);
      expect((await cache.peek('key'))!.data, ['fresh']);
    });

    test('a later successful refresh overwrites the earlier cached value', () async {
      await cache.refresh('key', () async => ['first']);
      await cache.refresh('key', () async => ['second']);

      expect((await cache.peek('key'))!.data, ['second']);
    });

    test('falls back to the cache when the fetch fails', () async {
      await cache.refresh('key', () async => ['cached']);

      final result = await cache.refresh('key', () async => throw Exception('offline'));

      expect(result.data, ['cached']);
      expect(result.source, CacheSource.cache);
      expect(result.isStale, isTrue);
    });

    test('rethrows the fetch error when there is nothing cached to fall back to', () async {
      await expectLater(
        cache.refresh('key', () async => throw Exception('offline')),
        throwsA(isException),
      );
    });

    test('different cache keys under the same resource never collide', () async {
      await cache.refresh('a', () async => ['for-a']);
      await cache.refresh('b', () async => ['for-b']);

      expect((await cache.peek('a'))!.data, ['for-a']);
      expect((await cache.peek('b'))!.data, ['for-b']);
    });
  });

  group('sync', () {
    test('yields only the network value on a first, successful load', () async {
      final values = await cache.sync('key', () async => ['fresh']).toList();

      expect(values, hasLength(1));
      expect(values.single.source, CacheSource.network);
    });

    test('yields the cached value first, then the reconciled network value', () async {
      await cache.refresh('key', () async => ['old']);

      final values = await cache.sync('key', () async => ['new']).toList();

      expect(values, hasLength(2));
      expect(values[0].data, ['old']);
      expect(values[0].source, CacheSource.cache);
      expect(values[1].data, ['new']);
      expect(values[1].source, CacheSource.network);
    });

    test('yields the cached value twice when the reconciling fetch fails', () async {
      await cache.refresh('key', () async => ['old']);

      final values = await cache
          .sync('key', () async => throw Exception('offline'))
          .toList();

      expect(values, hasLength(2));
      expect(values.every((value) => value.data.single == 'old'), isTrue);
      expect(values.every((value) => value.isStale), isTrue);
    });
  });

  test('clearAll wipes every resource, not just this one', () async {
    await cache.refresh('key', () async => ['data']);

    await database.clearAll();

    expect(await cache.peek('key'), isNull);
  });
}
