import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:studafy_mobile/src/core/offline/offline_database.dart';

/// QA-080: every cache row belongs to the account that wrote it. A row written by one user is
/// invisible to any other (a shared family phone, or a backup restored onto another account), and
/// nothing is read or written while no one is signed in.
void main() {
  String? owner;
  late OfflineDatabase database;

  setUp(() {
    owner = 'user-a';
    database = OfflineDatabase(NativeDatabase.memory(), () => owner);
  });
  tearDown(() => database.close());

  Future<void> writeFeed(String payload) => database.write(
    resource: 'announcements_inbox',
    cacheKey: 'feed',
    payload: payload,
    fetchedAt: DateTime.utc(2026, 11, 17),
  );

  test('a row is read back by the account that wrote it', () async {
    await writeFeed('["a"]');
    final row = await database.read(resource: 'announcements_inbox', cacheKey: 'feed');
    expect(row?.payload, '["a"]');
  });

  test('a row written by another account reads as null', () async {
    await writeFeed('["a"]');

    owner = 'user-b';
    expect(await database.read(resource: 'announcements_inbox', cacheKey: 'feed'), isNull);
    expect(await database.readAllForResource('announcements_inbox'), isEmpty);
  });

  test('two accounts with the same fixed cache key never see each other', () async {
    await writeFeed('["a"]');
    owner = 'user-b';
    await writeFeed('["b"]');

    expect(
      (await database.read(resource: 'announcements_inbox', cacheKey: 'feed'))?.payload,
      '["b"]',
    );
    owner = 'user-a';
    expect(
      (await database.read(resource: 'announcements_inbox', cacheKey: 'feed'))?.payload,
      '["a"]',
    );
  });

  test('deleting an entry only touches the current account', () async {
    await writeFeed('["a"]');
    owner = 'user-b';
    await database.deleteEntry(resource: 'announcements_inbox', cacheKey: 'feed');

    owner = 'user-a';
    expect(await database.read(resource: 'announcements_inbox', cacheKey: 'feed'), isNotNull);
  });

  test('with no signed-in account nothing is read or written', () async {
    await writeFeed('["a"]');

    owner = null;
    expect(await database.read(resource: 'announcements_inbox', cacheKey: 'feed'), isNull);
    await writeFeed('["signed-out"]');

    owner = 'user-a';
    expect(
      (await database.read(resource: 'announcements_inbox', cacheKey: 'feed'))?.payload,
      '["a"]',
    );
  });

  group('legacy on-disk copies', () {
    late Directory support;

    setUp(() async => support = await Directory.systemTemp.createTemp('offline_legacy_test'));
    tearDown(() async {
      if (await support.exists()) await support.delete(recursive: true);
    });

    test('the backed-up Application Support copies are deleted', () async {
      for (final name in ['offline_cache.sqlite', 'offline_cache.sqlite-wal']) {
        await File(p.join(support.path, name)).writeAsString('x');
      }
      await Directory(p.join(support.path, 'materials')).create();
      await File(p.join(support.path, 'materials', 'm1.pdf')).writeAsString('x');
      final unrelated = await File(p.join(support.path, 'keep.txt')).writeAsString('x');

      await deleteLegacyOfflineFiles(support);

      expect(await File(p.join(support.path, 'offline_cache.sqlite')).exists(), isFalse);
      expect(await File(p.join(support.path, 'offline_cache.sqlite-wal')).exists(), isFalse);
      expect(await Directory(p.join(support.path, 'materials')).exists(), isFalse);
      expect(await unrelated.exists(), isTrue);
    });

    test('nothing to delete is not an error', () async {
      await deleteLegacyOfflineFiles(support);
    });
  });
}
