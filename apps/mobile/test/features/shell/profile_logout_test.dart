import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_session.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';
import 'package:studafy_mobile/src/features/shell/presentation/pill_navigation_bar.dart';

import '../../support/fake_access_token.dart';
import '../../support/fake_secure_token_store.dart';
import '../../support/pump_app_shell.dart';
import '../../support/pump_studafy_app.dart';

/// The Profile tab's log-out flow, through the real app (router + auth guard), plus the
/// confirmation dialog's cancel path and the in-place language switch at shell altitude.
///
/// Only one test here pumps the real router — see auth_guard_boot_test.dart for why a second
/// `GoRouter` per test process is unreliable.
void main() {
  testWidgets(
    'confirming log out revokes the session and lands on the login screen',
    (tester) async {
      final paths = <String>[];
      final dio = Dio(BaseOptions(baseUrl: 'http://localhost'))
        ..httpClientAdapter = _FakeAdapter((options) {
          paths.add(options.path);
          return ResponseBody.fromString('', 204);
        });

      final client = MobileAuthClient(baseUrl: 'http://localhost', dio: dio);
      // The session revokes through its own client, so it gets the fake one too.
      final session = AuthSession(
        authClient: client,
        secureStore: FakeSecureTokenStore(),
      );
      await session.saveTokens(
        accessToken: fakeAccessToken(
          roles: const ['STUDENT'],
          sub: 'test-user',
        ),
        refreshToken: 'fake-refresh-token',
        sessionId: 'fake-session-id',
        expiresIn: 3600,
      );

      await pumpStudafyApp(
        tester,
        session: session,
        extraOverrides: [authClientProvider.overrideWithValue(client)],
      );

      await _openProfile(tester);
      expect(find.byKey(const Key('profileRole')), findsOneWidget);
      expect(find.text('Student'), findsOneWidget);

      await tester.ensureVisible(find.byKey(const Key('profileLogout')));
      await tester.tap(find.byKey(const Key('profileLogout')));
      await tester.pumpAndSettle();
      expect(find.text('Log out?'), findsOneWidget);

      await tester.tap(find.byKey(const Key('logoutConfirm')));
      await tester.pumpAndSettle();

      expect(paths, contains('/api/auth/logout'));
      expect(find.byType(PillNavigationBar), findsNothing);
      expect(find.byKey(const Key('brandLogo')), findsOneWidget);
    },
  );

  testWidgets('cancelling the log-out dialog keeps the session', (
    tester,
  ) async {
    await pumpAppShell(
      tester,
      session: await fakeAuthenticatedSession(roles: const ['PARENT']),
    );

    await _openProfile(tester);
    expect(find.text('Parent'), findsOneWidget);

    await tester.ensureVisible(find.byKey(const Key('profileLogout')));
    await tester.tap(find.byKey(const Key('profileLogout')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('logoutCancel')));
    await tester.pumpAndSettle();

    expect(find.text('Log out?'), findsNothing);
    expect(find.byType(PillNavigationBar), findsOneWidget);
  });

  testWidgets('the language selector switches the UI to Arabic in place', (
    tester,
  ) async {
    await pumpAppShell(
      tester,
      session: await fakeAuthenticatedSession(
        // The viewer shell: its Home tab touches no offline storage, which the real-async wait
        // below would otherwise reach (path_provider has no plugin in a widget test).
        roles: const ['ORG_ADMIN'],
      ),
    );

    await _openProfile(tester);
    await tester.ensureVisible(find.byKey(const Key('profileLanguage_ar')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('profileLanguage_ar')));
    await settleLocaleSwitch(tester);

    expect(find.text('تسجيل الخروج'), findsOneWidget);
    expect(find.text('اللغة'), findsOneWidget);
    expect(
      Directionality.of(tester.element(find.byType(PillNavigationBar))),
      TextDirection.rtl,
    );
  });
}

/// ar.json is over the 50 KB threshold above which `rootBundle.loadString` decodes on a
/// background isolate (`compute`), which never completes inside the test's fake-async zone.
/// Give that real async work a moment to finish before settling the frame.
Future<void> settleLocaleSwitch(WidgetTester tester) async {
  await tester.pump();
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 300)),
  );
  await tester.pumpAndSettle();
}

Future<void> _openProfile(WidgetTester tester) async {
  await tester.tap(
    find.descendant(
      of: find.byType(PillNavigationBar),
      matching: find.byIcon(Icons.person_outline),
    ),
  );
  await tester.pumpAndSettle();
}

class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this.respond);

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
