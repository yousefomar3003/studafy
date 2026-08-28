import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
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
        authStatusProvider.overrideWith((ref) => ref.watch(_fakeAuthStatus)),
      ],
    );
    addTearDown(container.dispose);
  });

  test('clears the cache when the session transitions from authenticated to unauthenticated', () async {
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
  });

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
}
