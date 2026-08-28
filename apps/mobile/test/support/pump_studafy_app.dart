import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/app.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_session.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';
import 'package:studafy_mobile/src/core/config/app_config.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';
import 'package:studafy_mobile/src/core/di/app_providers.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/core/monitoring/monitoring_providers.dart';

import 'fake_access_token.dart';
import 'fake_crash_reporter.dart';
import 'fake_secure_token_store.dart';
import 'wrap_with_localization.dart';

/// An [AuthSession] backed by [FakeSecureTokenStore], with no tokens saved — the
/// `restore()`/`saveTokens()`/`clear()` logic is real, only the platform storage is faked.
AuthSession fakeAuthSession() {
  return AuthSession(
    authClient: MobileAuthClient(baseUrl: 'http://localhost'),
    secureStore: FakeSecureTokenStore(),
  );
}

/// A [fakeAuthSession] pre-seeded with an access token carrying [roles], as if a login or
/// session restore had already happened.
Future<AuthSession> fakeAuthenticatedSession({required List<String> roles}) async {
  final session = fakeAuthSession();
  await session.saveTokens(
    accessToken: fakeAccessToken(roles: roles),
    refreshToken: 'fake-refresh-token',
    sessionId: 'fake-session-id',
    expiresIn: 3600,
  );
  return session;
}

/// Pumps the real [StudafyApp] — router, auth guard, theme, and localization all wired exactly
/// as production does — against a fake [session] instead of platform secure storage/network.
///
/// Defaults to an unauthenticated session (lands on the login screen). Pass a
/// [fakeAuthenticatedSession] to land on [AppShell] instead.
Future<void> pumpStudafyApp(
  WidgetTester tester, {
  AuthSession? session,
  Locale startLocale = AppLocales.fallback,
}) async {
  await tester.pumpWidget(
    // Keyed uniquely so each call gets a genuinely fresh element tree. Without this, two
    // `testWidgets` in the same file that both pump a structurally-identical tree can have
    // Flutter update the previous test's elements in place instead of rebuilding — which
    // would carry the previous test's `ProviderScope` container (and its already-resolved
    // `authNotifierProvider`/router state) into this one.
    KeyedSubtree(
      key: UniqueKey(),
      child: wrapWithLocalization(
        ProviderScope(
          overrides: [
            appConfigProvider.overrideWithValue(AppConfig.fromEnvironment(AppEnvironment.dev)),
            authSessionProvider.overrideWithValue(session ?? fakeAuthSession()),
            crashReporterProvider.overrideWithValue(FakeCrashReporter()),
          ],
          child: const StudafyApp(),
        ),
        startLocale: startLocale,
      ),
    ),
  );
  await tester.pumpAndSettle();
}
