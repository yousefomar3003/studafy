import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/core/offline/attachment_image_cache.dart';
import 'package:studafy_mobile/src/core/offline/material_file_cache.dart';

class _FakeAuthStatusNotifier extends Notifier<AuthStatus> {
  @override
  AuthStatus build() => AuthStatus.authenticated;
}

final _fakeAuthStatus = NotifierProvider<_FakeAuthStatusNotifier, AuthStatus>(
  _FakeAuthStatusNotifier.new,
);

/// QA-081: downloaded materials and chat/assignment pictures are wiped whenever the active account
/// stops being the signed-in one, not only on a plain logout. Logging out with another account on
/// the phone, or switching accounts, goes authenticated → loading → authenticated, and must not
/// leave the previous account's files on disk.
void main() {
  late Directory root;
  late ProviderContainer container;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('file_caches_switch_test');
    container = ProviderContainer(
      overrides: [
        offlineFilesRootProvider.overrideWithValue(() async => root),
        authStatusProvider.overrideWith((ref) => ref.watch(_fakeAuthStatus)),
      ],
    );
    // Keep both providers (and their auth listeners) alive, as the screens using them do.
    container.listen(materialFileCacheProvider, (_, _) {});
    container.listen(attachmentImageCacheProvider, (_, _) {});
  });

  tearDown(() async {
    container.dispose();
    if (await root.exists()) await root.delete(recursive: true);
  });

  Directory materials() => Directory(p.join(root.path, 'materials'));
  Directory pictures() => Directory(p.join(root.path, 'attachment_images'));

  Future<void> seedBothCaches() async {
    await container
        .read(materialFileCacheProvider)
        .save('material-1', 'notes.pdf', Uint8List.fromList([1, 2, 3]));
    await pictures().create(recursive: true);
    await File(p.join(pictures().path, 'chat_picture-1')).writeAsBytes([1, 2, 3]);
    expect(await materials().list().isEmpty, isFalse);
    expect(await pictures().list().isEmpty, isFalse);
  }

  /// The clears are fire-and-forget file deletes; wait for them rather than guess a delay.
  Future<bool> becomesEmpty(Directory dir) async {
    for (var i = 0; i < 100; i++) {
      try {
        if (!await dir.exists() || await dir.list().isEmpty) return true;
      } on FileSystemException {
        return true; // Deleted while being listed.
      }
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    return false;
  }

  void setStatus(AuthStatus status) => container.read(_fakeAuthStatus.notifier).state = status;

  test('an account switch (authenticated → loading → authenticated) clears both caches', () async {
    await seedBothCaches();

    setStatus(AuthStatus.loading);
    await Future<void>.delayed(Duration.zero);
    setStatus(AuthStatus.authenticated);

    expect(await becomesEmpty(materials()), isTrue, reason: 'materials');
    expect(await becomesEmpty(pictures()), isTrue, reason: 'pictures');
  });

  test('a plain logout still clears both caches', () async {
    await seedBothCaches();

    setStatus(AuthStatus.unauthenticated);

    expect(await becomesEmpty(materials()), isTrue, reason: 'materials');
    expect(await becomesEmpty(pictures()), isTrue, reason: 'pictures');
  });

  test('nothing is cleared while the session stays signed in', () async {
    await seedBothCaches();

    setStatus(AuthStatus.authenticated);
    await Future<void>.delayed(const Duration(milliseconds: 100));

    expect(await materials().list().isEmpty, isFalse);
    expect(await pictures().list().isEmpty, isFalse);
  });
}
