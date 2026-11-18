import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';

/// A notifier the test can flip directly, standing in for the real `authNotifierProvider`-backed
/// [authStatusProvider] — this test is only about [offlineDatabaseProvider]'s reaction to that
/// status, not about how auth itself resolves it.
class _FakeAuthStatusNotifier extends Notifier<AuthStatus> {
  @override
  AuthStatus build() => AuthStatus.authenticated;
}

final _fakeAuthStatus = NotifierProvider<_FakeAuthStatusNotifier, AuthStatus>(
  _FakeAuthStatusNotifier.new,
);

/// [offlineDatabaseProvider] reacts to [authStatusProvider] via `ref.listen`, which Riverpod only
/// flushes promptly while something actively watches the listening provider — in the real app
/// that's always true (every repository provider watches it, in turn watched by a screen), but a
/// bare `container.read` here leaves nothing watching it. This keeps it active the same way.
void _keepAlive(ProviderContainer container) {
  container.listen(offlineDatabaseProvider, (_, _) {});
}

void main() {
  late ProviderContainer container;

  setUp(() {
    container = ProviderContainer(
      overrides: [
        offlineDatabaseExecutorProvider.overrideWithValue(NativeDatabase.memory()),
        offlineCacheOwnerProvider.overrideWithValue(() => 'user-1'),
        authStatusProvider.overrideWith((ref) => ref.watch(_fakeAuthStatus)),
      ],
    );
    addTearDown(container.dispose);
  });

  test(
    'clears the cache when the session transitions from authenticated to unauthenticated',
    () async {
      _keepAlive(container);
      final database = container.read(offlineDatabaseProvider);
      await database.write(
        resource: 'materials',
        cacheKey: 'class-1',
        payload: '[]',
        fetchedAt: DateTime.now(),
      );
      expect(await database.read(resource: 'materials', cacheKey: 'class-1'), isNotNull);

      container.read(_fakeAuthStatus.notifier).state = AuthStatus.unauthenticated;
      await Future<void>.delayed(Duration.zero);

      expect(await database.read(resource: 'materials', cacheKey: 'class-1'), isNull);
    },
  );

  test('does not clear the cache while the session stays authenticated', () async {
    _keepAlive(container);
    final database = container.read(offlineDatabaseProvider);
    await database.write(
      resource: 'materials',
      cacheKey: 'class-1',
      payload: '[]',
      fetchedAt: DateTime.now(),
    );

    container.read(_fakeAuthStatus.notifier).state = AuthStatus.authenticated;
    await Future<void>.delayed(Duration.zero);

    expect(await database.read(resource: 'materials', cacheKey: 'class-1'), isNotNull);
  });

  test('does not clear the cache on the initial loading-to-unauthenticated resolution', () async {
    final bootContainer = ProviderContainer(
      overrides: [
        offlineDatabaseExecutorProvider.overrideWithValue(NativeDatabase.memory()),
        offlineCacheOwnerProvider.overrideWithValue(() => 'user-1'),
        authStatusProvider.overrideWith((ref) => ref.watch(_fakeAuthStatus)),
      ],
    );
    addTearDown(bootContainer.dispose);
    _keepAlive(bootContainer);
    bootContainer.read(_fakeAuthStatus.notifier).state = AuthStatus.loading;

    final database = bootContainer.read(offlineDatabaseProvider);
    await database.write(
      resource: 'materials',
      cacheKey: 'class-1',
      payload: '[]',
      fetchedAt: DateTime.now(),
    );

    // Boot resolving straight to unauthenticated (no prior session) is not a logout.
    bootContainer.read(_fakeAuthStatus.notifier).state = AuthStatus.unauthenticated;
    await Future<void>.delayed(Duration.zero);

    expect(await database.read(resource: 'materials', cacheKey: 'class-1'), isNotNull);
  });

  // QA-080: a previous user's rows must not wait on disk for the next sign-in. Opening the cache
  // with no active session (the app booted signed out) wipes it.
  test('wipes the cache when it opens with no active session', () async {
    final dir = await Directory.systemTemp.createTemp('offline_boot_clear_test');
    addTearDown(() => dir.delete(recursive: true));
    final file = File('${dir.path}/offline_cache.sqlite');

    final previous = OfflineDatabase(NativeDatabase(file), () => 'user-1');
    await previous.write(
      resource: 'published_grades',
      cacheKey: 'student-1',
      payload: '[]',
      fetchedAt: DateTime.now(),
    );
    await previous.close();

    final bootContainer = ProviderContainer(
      overrides: [
        offlineDatabaseExecutorProvider.overrideWithValue(NativeDatabase(file)),
        offlineCacheOwnerProvider.overrideWithValue(() => null),
        authStatusProvider.overrideWith((ref) => ref.watch(_fakeAuthStatus)),
      ],
    );
    _keepAlive(bootContainer);
    bootContainer.read(_fakeAuthStatus.notifier).state = AuthStatus.unauthenticated;
    // Drift runs statements in order, so a read on the same connection waits for the wipe.
    final booted = bootContainer.read(offlineDatabaseProvider);
    await booted.readAllForResource('published_grades');
    bootContainer.dispose();
    await Future<void>.delayed(Duration.zero);

    final reopened = OfflineDatabase(NativeDatabase(file), () => 'user-1');
    addTearDown(reopened.close);
    expect(await reopened.read(resource: 'published_grades', cacheKey: 'student-1'), isNull);
  });

  test('keeps the cache when it opens with a restored session', () async {
    _keepAlive(container);
    final database = container.read(offlineDatabaseProvider);
    await database.write(
      resource: 'materials',
      cacheKey: 'class-1',
      payload: '[]',
      fetchedAt: DateTime.now(),
    );
    expect(await database.read(resource: 'materials', cacheKey: 'class-1'), isNotNull);
  });
}
