import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_session.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';
import 'package:studafy_mobile/src/core/auth/saved_account.dart';
import 'package:studafy_mobile/src/core/config/app_config.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';
import 'package:studafy_mobile/src/core/di/app_providers.dart';

import '../../support/fake_access_token.dart';
import '../../support/fake_secure_token_store.dart';

/// Several accounts on one phone (a parent with children at two schools): setting the active one
/// aside, switching between them, and what logging out of one does to the others.
void main() {
  const schoolA = AccountLabel(
    displayName: 'Rania Khalil',
    schoolName: 'Demo Academy',
    memberIds: ['PAR-100001'],
  );

  test('"Add account" sets the active account aside and opens login', () async {
    final harness = await _Harness.signedIn('parent-a');

    await harness.auth.addAccount(current: schoolA);

    expect(harness.status, AuthStatus.unauthenticated);
    expect(harness.session.isAuthenticated, isFalse);
    final saved = harness.container.read(savedAccountsProvider).single;
    expect(saved.userId, 'parent-a');
    expect(saved.label.schoolName, 'Demo Academy');
    expect(saved.refreshToken, 'refresh-parent-a');
    // Persisted, so the account is still there after the app restarts.
    expect(harness.store.savedAccounts, contains('parent-a'));
    // Set aside, not signed out: the server session is untouched.
    expect(harness.paths, isNot(contains('/api/auth/logout')));
  });

  test(
    'switching makes the saved account active and sets the current one aside',
    () async {
      final harness = await _Harness.signedIn(
        'parent-a',
        saved: [_saved('parent-b', label: 'Second School')],
      );

      expect(await harness.auth.switchTo('parent-b', current: schoolA), isTrue);

      expect(harness.status, AuthStatus.authenticated);
      expect(harness.session.userId, 'parent-b');
      final saved = harness.container.read(savedAccountsProvider);
      expect(saved.map((account) => account.userId), ['parent-a']);
      expect(saved.single.label.displayName, 'Rania Khalil');
    },
  );

  test(
    'a student switches to a parent and a sibling, and back, without signing in again',
    () async {
      const student = AccountLabel(
        displayName: 'Omar Khalil',
        schoolName: 'Demo Academy',
      );
      final harness = await _Harness.signedIn(
        'student-omar',
        roles: const ['STUDENT'],
        saved: [
          _saved('parent-rania'),
          _saved('student-lina', roles: const ['STUDENT']),
        ],
      );

      expect(
        await harness.auth.switchTo('parent-rania', current: student),
        isTrue,
      );
      expect(harness.session.userId, 'parent-rania');
      expect(harness.session.roles, ['PARENT']);

      expect(
        await harness.auth.switchTo(
          'student-lina',
          current: const AccountLabel(),
        ),
        isTrue,
      );
      expect(harness.session.userId, 'student-lina');
      expect(harness.session.roles, ['STUDENT']);

      expect(
        await harness.auth.switchTo(
          'student-omar',
          current: const AccountLabel(),
        ),
        isTrue,
      );
      expect(harness.status, AuthStatus.authenticated);
      expect(harness.session.userId, 'student-omar');
      expect(
        harness.container
            .read(savedAccountsProvider)
            .map((account) => account.userId),
        unorderedEquals(['parent-rania', 'student-lina']),
      );
      expect(harness.paths, isNot(contains('/api/auth/logout')));
    },
  );

  test('an expired saved account renews on the way in', () async {
    final harness = await _Harness.signedIn(
      'parent-a',
      saved: [_saved('parent-b', expired: true)],
      respond: (options) => options.path == '/api/auth/refresh'
          ? _json({
              'access_token': fakeAccessToken(sub: 'parent-b'),
              'token_type': 'Bearer',
              'expires_in': 900,
              'session_id': 'session-parent-b',
              'refresh_token': 'refresh-parent-b-2',
            })
          : ResponseBody.fromString('', 204),
    );

    expect(await harness.auth.switchTo('parent-b', current: schoolA), isTrue);

    expect(harness.paths, contains('/api/auth/refresh'));
    expect(harness.status, AuthStatus.authenticated);
    expect(harness.session.userId, 'parent-b');
  });

  test(
    'a saved account whose session ended is dropped and login opens',
    () async {
      final harness = await _Harness.signedIn(
        'parent-a',
        saved: [_saved('parent-b', expired: true)],
        respond: (options) => options.path == '/api/auth/refresh'
            ? ResponseBody.fromString(
                '{"code":"AUTH_INVALID_REFRESH_TOKEN"}',
                401,
              )
            : ResponseBody.fromString('', 204),
      );

      expect(
        await harness.auth.switchTo('parent-b', current: schoolA),
        isFalse,
      );

      expect(harness.status, AuthStatus.unauthenticated);
      // The account that was active stays saved; the dead one is gone.
      expect(
        harness.container
            .read(savedAccountsProvider)
            .map((account) => account.userId),
        ['parent-a'],
      );
    },
  );

  test('logging out of one account opens the next saved one', () async {
    final harness = await _Harness.signedIn(
      'parent-a',
      saved: [_saved('parent-b')],
    );

    await harness.auth.logout();

    expect(harness.paths, contains('/api/auth/logout'));
    expect(harness.status, AuthStatus.authenticated);
    expect(harness.session.userId, 'parent-b');
    expect(harness.container.read(savedAccountsProvider), isEmpty);
  });

  test('logging out of the only account returns to login', () async {
    final harness = await _Harness.signedIn('parent-a');

    await harness.auth.logout();

    expect(harness.status, AuthStatus.unauthenticated);
  });

  test(
    'signing in to a saved account replaces it rather than listing it twice',
    () async {
      final harness = await _Harness.signedIn(
        'parent-a',
        respond: (options) => options.path == '/api/auth/login/member'
            ? _json({
                'access_token': fakeAccessToken(sub: 'parent-a'),
                'token_type': 'Bearer',
                'expires_in': 900,
                'session_id': 'session-parent-a-2',
                'refresh_token': 'refresh-parent-a-2',
              })
            : ResponseBody.fromString('', 204),
      );
      await harness.auth.addAccount(current: schoolA);

      await harness.auth.loginWithMember(
        username: 'PAR-100001',
        password: 'secret-pass',
      );

      expect(harness.status, AuthStatus.authenticated);
      expect(harness.container.read(savedAccountsProvider), isEmpty);
    },
  );

  test('removing a saved account ends its session on the server', () async {
    final harness = await _Harness.signedIn(
      'parent-a',
      saved: [_saved('parent-b')],
    );

    await harness.auth.removeSavedAccount('parent-b');

    expect(harness.container.read(savedAccountsProvider), isEmpty);
    expect(harness.paths, contains('/api/auth/logout'));
    expect(harness.store.savedAccounts, isNull);
    // The active account is untouched.
    expect(harness.session.userId, 'parent-a');
  });
}

SavedAccount _saved(
  String userId, {
  String? label,
  bool expired = false,
  List<String> roles = const ['PARENT'],
}) => SavedAccount(
  userId: userId,
  accessToken: fakeAccessToken(
    sub: userId,
    roles: roles,
    expiresAt: expired
        ? DateTime.now().subtract(const Duration(hours: 1))
        : null,
  ),
  refreshToken: 'refresh-$userId',
  sessionId: 'session-$userId',
  roles: roles,
  label: AccountLabel(schoolName: label),
);

class _Harness {
  _Harness(this.container, this.session, this.store, this.paths);

  final ProviderContainer container;
  final AuthSession session;
  final FakeSecureTokenStore store;
  final List<String> paths;

  AuthNotifier get auth => container.read(authNotifierProvider.notifier);
  AuthStatus get status => container.read(authNotifierProvider);

  static Future<_Harness> signedIn(
    String userId, {
    List<SavedAccount> saved = const [],
    List<String> roles = const ['PARENT'],
    ResponseBody Function(RequestOptions options)? respond,
  }) async {
    final paths = <String>[];
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost'))
      ..httpClientAdapter = _Adapter((options) {
        paths.add(options.path);
        return respond?.call(options) ?? ResponseBody.fromString('', 204);
      });
    final client = MobileAuthClient(baseUrl: 'http://localhost', dio: dio);
    final store = FakeSecureTokenStore()
      ..savedAccounts = saved.isEmpty
          ? null
          : jsonEncode([for (final account in saved) account.toJson()]);
    final session = AuthSession(authClient: client, secureStore: store);
    await session.saveTokens(
      accessToken: fakeAccessToken(sub: userId, roles: roles),
      refreshToken: 'refresh-$userId',
      sessionId: 'session-$userId',
      expiresIn: 3600,
    );

    final container = ProviderContainer(
      overrides: [
        appConfigProvider.overrideWithValue(
          AppConfig.fromEnvironment(AppEnvironment.dev),
        ),
        authClientProvider.overrideWithValue(client),
        authSessionProvider.overrideWithValue(session),
        secureTokenStoreProvider.overrideWithValue(store),
      ],
    );
    addTearDown(container.dispose);

    container.read(authNotifierProvider);
    container.read(savedAccountsProvider);
    for (
      var i = 0;
      i < 20 && container.read(authNotifierProvider) == AuthStatus.loading;
      i++
    ) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(container.read(authNotifierProvider), AuthStatus.authenticated);
    return _Harness(container, session, store, paths);
  }
}

ResponseBody _json(Map<String, dynamic> body) => ResponseBody.fromString(
  jsonEncode(body),
  200,
  headers: {
    Headers.contentTypeHeader: ['application/json'],
  },
);

class _Adapter implements HttpClientAdapter {
  _Adapter(this.respond);

  final ResponseBody Function(RequestOptions options) respond;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => respond(options);

  @override
  void close({bool force = false}) {}
}
