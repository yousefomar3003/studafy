import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/offline/attachment_image_cache.dart';

/// Answers every GET with [body] (or [status]) and records the URLs asked for.
class _Adapter implements HttpClientAdapter {
  _Adapter(this.body);

  Uint8List body;
  int status = 200;
  final requested = <String>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requested.add(options.uri.toString());
    return ResponseBody.fromBytes(body, status);
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  late Directory root;
  late _Adapter adapter;

  AttachmentImageCache cache({int maxBytes = 1 << 20}) => AttachmentImageCache(
    root: () async => root,
    dio: Dio()..httpClientAdapter = adapter,
    maxBytes: maxBytes,
  );

  /// Lets the cache's fire-and-forget disk write finish.
  Future<void> settle() =>
      Future<void>.delayed(const Duration(milliseconds: 50));

  /// Waits (up to 5 s) until [done] holds. The cache writes and prunes in the background, and a
  /// fixed delay is not enough on a slow CI runner.
  Future<void> until(bool Function() done) async {
    for (var i = 0; i < 500 && !done(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  File cached(String id) => File(
    '${root.path}/attachment_images/${AttachmentImageCache.fileNameFor('chat', id)}',
  );

  setUp(() async {
    root = await Directory.systemTemp.createTemp('attachment_image_cache_test');
    adapter = _Adapter(Uint8List.fromList([1, 2, 3]));
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  test('downloads once per id, whatever URL it is later asked with', () async {
    final first = cache();
    expect(await first.load('chat', 'a1', 'https://storage.test/a1?sig=1'), [
      1,
      2,
      3,
    ]);
    await settle();

    // A new instance (an app restart) with a re-minted URL: served from disk.
    final second = cache();
    expect(await second.load('chat', 'a1', 'https://storage.test/a1?sig=2'), [
      1,
      2,
      3,
    ]);
    expect(adapter.requested, ['https://storage.test/a1?sig=1']);

    // A different picture is its own download.
    await second.load('chat', 'a2', 'https://storage.test/a2?sig=1');
    expect(adapter.requested, hasLength(2));
  });

  test('concurrent loads of one picture share a download', () async {
    final c = cache();
    await Future.wait([
      c.load('chat', 'a1', 'https://storage.test/a1?sig=1'),
      c.load('chat', 'a1', 'https://storage.test/a1?sig=2'),
    ]);
    expect(adapter.requested, hasLength(1));
  });

  test('namespaces do not collide', () async {
    final c = cache();
    await c.load('chat', 'x', 'https://storage.test/chat-x');
    await settle();
    await c.load('question', 'x', 'https://storage.test/question-x');
    expect(adapter.requested, hasLength(2));
  });

  test('a failed download is not cached', () async {
    final c = cache();
    adapter.status = 403;
    await expectLater(
      c.load('chat', 'a1', 'https://storage.test/expired'),
      throwsA(anything),
    );
    adapter.status = 200;
    expect(await c.load('chat', 'a1', 'https://storage.test/fresh'), [1, 2, 3]);
    expect(adapter.requested, [
      'https://storage.test/expired',
      'https://storage.test/fresh',
    ]);
  });

  test('clear wipes everything', () async {
    final c = cache();
    await c.load('chat', 'a1', 'https://storage.test/a1');
    await settle();
    await c.clear();
    await c.load('chat', 'a1', 'https://storage.test/a1');
    expect(adapter.requested, hasLength(2));
  });

  test(
    'keeps the total under the cap, dropping the least recently used',
    () async {
      adapter.body = Uint8List(400);
      final c = cache(maxBytes: 1000);
      // The first write always checks the size; it is under the cap.
      await c.load('chat', 'old', 'https://storage.test/old');
      await until(() => cached('old').existsSync());
      final dir = Directory('${root.path}/attachment_images');
      await cached('old').setLastModified(DateTime(2020));
      for (final id in ['b', 'c']) {
        await c.load('chat', id, 'https://storage.test/$id');
        await until(() => cached(id).existsSync());
      }
      // Over the cap now (1200 bytes), but the next check is a few writes away.
      expect(dir.listSync(), hasLength(3));

      // The 20th write since the first check checks again.
      for (var i = 0; i < 18; i++) {
        await c.load('chat', 'n$i', 'https://storage.test/n$i');
        await until(() => cached('n$i').existsSync());
      }
      // The prune runs after the 20th write's rename; wait for it to drop the oldest file.
      await until(() => !cached('old').existsSync());
      await settle();
      final names = dir.listSync().map((e) => e.uri.pathSegments.last).toSet();
      final total = dir.listSync().whereType<File>().fold<int>(
        0,
        (sum, f) => sum + f.lengthSync(),
      );
      expect(total, lessThanOrEqualTo(750));
      expect(
        names,
        isNot(contains(AttachmentImageCache.fileNameFor('chat', 'old'))),
      );
    },
  );

  test('a missing cache directory falls back to downloading', () async {
    final c = AttachmentImageCache(
      root: () async => throw const FileSystemException('no plugin'),
      dio: Dio()..httpClientAdapter = adapter,
    );
    expect(await c.load('chat', 'a1', 'https://storage.test/a1'), [1, 2, 3]);
    expect(await c.load('chat', 'a1', 'https://storage.test/a1'), [1, 2, 3]);
    expect(adapter.requested, hasLength(2));
  });

  test('provider equality ignores the URL', () {
    final c = cache();
    AttachmentImageProvider provider(String url, {int? width}) =>
        AttachmentImageProvider(
          cache: c,
          namespace: 'chat',
          id: 'a1',
          url: url,
          cacheWidth: width,
        );
    expect(provider('https://x/1'), provider('https://x/2'));
    expect(provider('https://x/1').hashCode, provider('https://x/2').hashCode);
    expect(provider('https://x/1', width: 200), isNot(provider('https://x/1')));
  });
}
