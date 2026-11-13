import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:studafy_mobile/src/core/api/api_client.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/auth_session.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';
import 'package:studafy_mobile/src/core/auth/saved_account.dart';
import 'package:studafy_mobile/src/core/config/app_config.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';
import 'package:studafy_mobile/src/core/di/app_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/parent/application/child_device_providers.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/child_phone_account_button.dart';

import '../../../support/fake_access_token.dart';
import '../../../support/fake_secure_token_store.dart';
import '../../../support/wrap_with_localization.dart';

/// "Add (child) to this phone": the parent's sign-in opens the child's own session, which goes into
/// the account switcher set aside (the parent stays active); the button then offers "Open".
void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test(
    'adds the child account to the switcher without making it active',
    () async {
      final harness = await _Harness.parent();

      final childUserId = await harness.container
          .read(childDeviceAccountsProvider.notifier)
          .add('stu-amir');

      expect(childUserId, 'child-amir');
      expect(
        harness.paths,
        contains('/api/auth/guardian/children/stu-amir/session'),
      );
      // The parent is still the active account.
      expect(harness.session.userId, 'parent-1');
      expect(
        harness.container.read(authNotifierProvider),
        AuthStatus.authenticated,
      );
      final saved = harness.container.read(savedAccountsProvider).single;
      expect(saved.userId, 'child-amir');
      expect(saved.refreshToken, 'refresh-child-amir');
      expect(saved.roles, ['STUDENT']);
      expect(saved.label.displayName, 'Amir Haddad');
      expect(saved.label.memberIds, ['STU-100009']);
      // Persisted, so the Keychain-backed switcher still has it after a restart.
      expect(harness.store.savedAccounts, contains('child-amir'));
      expect(
        harness.container.read(childAccountOnPhoneProvider('stu-amir')),
        'child-amir',
      );
    },
  );

  test(
    'switching to the child and back still shows the child as on this phone',
    () async {
      final harness = await _Harness.parent();
      await harness.container
          .read(childDeviceAccountsProvider.notifier)
          .add('stu-amir');

      expect(
        await harness.auth.switchTo(
          'child-amir',
          current: const AccountLabel(),
        ),
        isTrue,
      );
      expect(harness.session.userId, 'child-amir');
      expect(
        await harness.auth.switchTo('parent-1', current: const AccountLabel()),
        isTrue,
      );
      expect(harness.session.userId, 'parent-1');

      await harness.container.read(childDeviceAccountsProvider.future);
      expect(
        harness.container.read(childAccountOnPhoneProvider('stu-amir')),
        'child-amir',
      );
    },
  );

  test(
    'a child already signed in the ordinary way has that older session ended',
    () async {
      final harness = await _Harness.parent(
        saved: [
          SavedAccount(
            userId: 'child-amir',
            accessToken: fakeAccessToken(
              sub: 'child-amir',
              roles: const ['STUDENT'],
            ),
            refreshToken: 'old-refresh',
            sessionId: 'old-session',
            roles: const ['STUDENT'],
            label: const AccountLabel(displayName: 'Amir'),
          ),
        ],
      );

      await harness.container
          .read(childDeviceAccountsProvider.notifier)
          .add('stu-amir');

      expect(harness.paths, contains('/api/auth/logout'));
      final saved = harness.container.read(savedAccountsProvider).single;
      expect(saved.refreshToken, 'refresh-child-amir');
    },
  );

  testWidgets('the button adds, then offers to open', (tester) async {
    final harness = await tester.runAsync(_Harness.parent);
    await tester.pumpWidget(harness!.app());
    await tester.pumpAndSettle();

    expect(find.text('Add Amir to this phone'), findsOneWidget);
    // The add runs real I/O (the fake HTTP adapter, preferences), so drive it in real time.
    await tester.runAsync(() async {
      await tester.tap(find.text('Add Amir to this phone'));
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('Open Amir'), findsOneWidget);
    expect(find.textContaining('Amir is on this phone'), findsOneWidget);
  });

  testWidgets('a school that turned it off says so', (tester) async {
    final harness = await tester.runAsync(
      () => _Harness.parent(
        respond: (options) => options.path.startsWith('/api/auth/guardian/')
            ? _json({
                'type': 'about:blank',
                'title': 'Forbidden',
                'status': 403,
                'code': 'AUTHZ_FORBIDDEN',
              }, status: 403)
            : null,
      ),
    );
    await tester.pumpWidget(harness!.app());
    await tester.pumpAndSettle();

    // The add runs real I/O (the fake HTTP adapter, preferences), so drive it in real time.
    await tester.runAsync(() async {
      await tester.tap(find.text('Add Amir to this phone'));
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(
      find.textContaining('Your school has turned this off'),
      findsOneWidget,
    );
    expect(find.text('Add Amir to this phone'), findsOneWidget);
    expect(harness.container.read(savedAccountsProvider), isEmpty);
  });
}

class _Harness {
  _Harness(this.container, this.session, this.store, this.paths);

  final ProviderContainer container;
  final AuthSession session;
  final FakeSecureTokenStore store;
  final List<String> paths;

  AuthNotifier get auth => container.read(authNotifierProvider.notifier);

  Widget app() => wrapWithLocalization(
    UncontrolledProviderScope(
      container: container,
      child: Builder(
        builder: (context) => MaterialApp(
          theme: AppTheme.light,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          home: const Scaffold(
            body: Center(
              child: ChildPhoneAccountButton(
                studentId: 'stu-amir',
                childName: 'Amir Haddad',
              ),
            ),
          ),
        ),
      ),
    ),
  );

  static Future<_Harness> parent({
    List<SavedAccount> saved = const [],
    ResponseBody? Function(RequestOptions options)? respond,
  }) async {
    final paths = <String>[];
    ResponseBody handle(RequestOptions options) {
      paths.add(options.path);
      final custom = respond?.call(options);
      if (custom != null) return custom;
      if (options.path == '/api/auth/guardian/children/stu-amir/session') {
        return _json({
          'access_token': fakeAccessToken(
            sub: 'child-amir',
            roles: const ['STUDENT'],
          ),
          'token_type': 'Bearer',
          'expires_in': 900,
          'session_id': 'session-child-amir',
          'refresh_token': 'refresh-child-amir',
          'child': {
            'user_id': 'child-amir',
            'display_name': 'Amir Haddad',
            'school_name': 'Demo Academy',
            'member_ids': ['STU-100009'],
          },
        });
      }
      return ResponseBody.fromString('', 204);
    }

    Dio fakeDio() =>
        Dio(BaseOptions(baseUrl: 'http://localhost'))
          ..httpClientAdapter = _Adapter(handle);
    final authClient = MobileAuthClient(
      baseUrl: 'http://localhost',
      dio: fakeDio(),
    );
    final store = FakeSecureTokenStore()
      ..savedAccounts = saved.isEmpty
          ? null
          : jsonEncode([for (final account in saved) account.toJson()]);
    final session = AuthSession(authClient: authClient, secureStore: store);
    await session.saveTokens(
      accessToken: fakeAccessToken(sub: 'parent-1', roles: const ['PARENT']),
      refreshToken: 'refresh-parent-1',
      sessionId: 'session-parent-1',
      expiresIn: 3600,
    );

    final container = ProviderContainer(
      overrides: [
        appConfigProvider.overrideWithValue(
          AppConfig.fromEnvironment(AppEnvironment.dev),
        ),
        authClientProvider.overrideWithValue(authClient),
        authSessionProvider.overrideWithValue(session),
        secureTokenStoreProvider.overrideWithValue(store),
        apiClientProvider.overrideWithValue(
          createApiClient(
            baseUrl: Uri.parse('http://localhost'),
            dio: fakeDio(),
          ),
        ),
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
    await container.read(childDeviceAccountsProvider.future);
    return _Harness(container, session, store, paths);
  }
}

ResponseBody _json(Map<String, dynamic> body, {int status = 200}) =>
    ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [
          status == 200 ? 'application/json' : 'application/problem+json',
        ],
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
